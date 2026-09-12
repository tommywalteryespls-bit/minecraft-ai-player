import type { Logger } from 'pino';
import type { Response, ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';
import type { AgentEvent } from '../core/events.js';
import { errorMessage } from '../utils/errors.js';
import { Mutex } from '../utils/mutex.js';
import { ContextBuilder } from './contextBuilder.js';
import { OpenAIService } from './openai.js';
import { systemPrompt, playerControlPrompt, playerControlContinuation, baseSearchPrompt } from './prompts.js';
import { ToolExecutor } from './toolExecutor.js';
import { minecraftTools, toolForController } from './tools.js';
import { setTimeout as delay } from 'node:timers/promises';

export interface PlannerResult {
  text: string;
  responseId: string | null;
  toolCalls: number;
  toolNames: string[];
}

export class Planner {
  private readonly mutex = new Mutex();
  private pending = 0;
  private pendingPlayers = 0;
  private closed = false;
  private controller = new AbortController();

  constructor(
    private readonly openai: OpenAIService,
    private readonly context: ContextBuilder,
    private readonly executor: ToolExecutor,
    private readonly logger: Logger,
    private readonly aiName: string,
    private readonly owner: string,
    private readonly model: string,
    private readonly maxToolRounds: number,
    private readonly unrestricted = false
  ) {}

  get busy(): boolean {
    return this.pending > 0;
  }

  async think(event: AgentEvent, requestSignal?: AbortSignal): Promise<PlannerResult> {
    if (this.closed) throw new Error('Planner is closed');
    const playerRequest = event.type === 'PLAYER_SPOKE';
    // Background observations may coalesce, but a player's request must wait its turn.
    if (this.busy && !playerRequest) return { text: '', responseId: null, toolCalls: 0, toolNames: [] };
    if (this.pending >= 20) throw new Error('Planner queue is full; please try again shortly');
    const signal = requestSignal ? AbortSignal.any([this.controller.signal, requestSignal]) : this.controller.signal;
    this.pending += 1;
    if (playerRequest) this.pendingPlayers += 1;
    try {
      return await this.mutex.runExclusive(async () => {
        signal.throwIfAborted();
        return this.run(event, signal);
      });
    } finally {
      this.pending -= 1;
      if (playerRequest) this.pendingPlayers -= 1;
    }
  }

  cancel(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  close(): void {
    this.closed = true;
    this.cancel();
  }

  private async run(event: AgentEvent, signal: AbortSignal): Promise<PlannerResult> {
    try {
      const playerRequest = event.type === 'PLAYER_SPOKE';
      const voiceRequest = playerRequest && event.data?.channel === 'voice';
      const available = this.executor.availableToolNames?.();
      const clientControl = this.executor.isClientControl?.() ?? false;
      const unlimited = clientControl && this.unrestricted;
      // Explicit continuing tasks must not terminate just because the model narrates progress.
      const untilStopped = unlimited && typeof event.data?.message === 'string'
        && /\buntil\s+(?:i|we)\s+(?:(?:say|tell\s+you\s+to)\s+)?stop\b/i.test(event.data.message);
      const gameplay = Boolean(available?.includes('acquire_item'));
      const tools = minecraftTools.filter((tool) => (!voiceRequest || tool.name !== 'say') && (!available || available.includes(tool.name))).map((tool) => toolForController(tool, clientControl, unlimited, gameplay));
      const instructions = (clientControl ? playerControlPrompt(this.aiName, unlimited, gameplay) : systemPrompt(this.aiName, this.owner))
        + (clientControl && available?.includes('search_for_base') ? baseSearchPrompt() : '') + (playerRequest
        ? '\nA player is addressing you. After any necessary tools, always return a short, natural final reply grounded in the tool results.'
          + (voiceRequest ? ' Your final text is spoken aloud. The text-chat say tool is unavailable for this voice turn.' : '')
        : '');
      const client = this.openai.requireClient();
      const username = typeof event.data?.username === 'string' ? event.data.username : undefined;
      const context = await this.context.build(`${event.type} ${event.summary}`, username);
      signal.throwIfAborted();
      let response: Response = await client.responses.create({
        model: this.model,
        instructions: instructions + (clientControl ? playerControlContinuation(this.maxToolRounds, unlimited) : ''),
        input: `EVENT\n${JSON.stringify(event)}\n\nDECISION CONTEXT\n${JSON.stringify(context)}`,
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        max_output_tokens: 1200,
        store: true
      }, { signal });
      let toolCalls = 0;
      const toolNames: string[] = [];
      let localContinuingAction = false;
      let dedicatedSearchFinished = false;
      for (let round = 0; unlimited || round < this.maxToolRounds; round += 1) {
        signal.throwIfAborted();
        this.checkResponse(response);
        const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === 'function_call');
        if (!calls.length) {
          if (!untilStopped || localContinuingAction) break;
          // A progress-only response is not a stop request. Refresh state before continuing.
          // Yield between attempts so a temporarily blocked task is interruptible without a hot loop.
          await delay(2000, undefined, { signal });
          const refreshed = await this.context.build(`${event.type} ${event.summary}`, username);
          signal.throwIfAborted();
          response = await client.responses.create({
            model: this.model, instructions: instructions + playerControlContinuation(0, true),
            previous_response_id: response.id,
            input: `The user's explicit until-stop task is still active. They have not asked to stop. Continue supported steps from the confirmed progress so far.\nORIGINAL REQUEST\n${JSON.stringify(event)}\nCURRENT CONTEXT\n${JSON.stringify(refreshed)}`,
            tools, tool_choice: 'auto', parallel_tool_calls: false, max_output_tokens: 1200, store: true
          }, { signal });
          continue;
        }
        const outputs: ResponseInputItem[] = [];
        for (const call of calls) {
          signal.throwIfAborted();
          toolCalls += 1;
          toolNames.push(call.name);
          // Keep response metadata bounded in a long-running task; the total counter and action log remain complete.
          if (unlimited && toolNames.length > 128) toolNames.shift();
          const result = dedicatedSearchFinished
            ? { success: false, action: call.name, reason: 'Base search returned; report the finding or blocker and wait for the user before further gameplay.' }
            : voiceRequest && call.name === 'say'
            ? { success: false, action: 'say', reason: 'Return your reply as final text for voice playback instead.' }
            : await this.executor.execute(call.name, call.arguments, signal);
          if (['search_for_base', 'resume_base_search'].includes(call.name)) dedicatedSearchFinished = true;
          if (!['inspect_surroundings', 'inspect_inventory', 'inspect_server_capabilities', 'remember_location', 'recall_location', 'remember_lesson', 'list_goals'].includes(call.name)) {
            localContinuingAction = result.success && 'data' in result && result.data?.untilStopped === true;
          }
          this.logger.info({ tool: call.name, result }, 'AI tool completed');
          outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
        }
        signal.throwIfAborted();
        // Reserve the final request for speech/text, with every tool result supplied.
        const finish = dedicatedSearchFinished || (!unlimited && round === this.maxToolRounds - 1) || (!playerRequest && this.pendingPlayers > 0);
        response = await client.responses.create({
          model: this.model,
          instructions: instructions + (clientControl ? playerControlContinuation(this.maxToolRounds - round - 1, unlimited) : '')
            + (finish ? '\nFinish now with a concise final reply. Describe only confirmed outcomes; no further actions this turn.' : ''),
          previous_response_id: response.id,
          input: outputs,
          tools,
          tool_choice: finish ? 'none' : 'auto',
          parallel_tool_calls: false,
          max_output_tokens: finish ? 2400 : 1200,
          store: true
        }, { signal });
        if (finish) break;
      }
      signal.throwIfAborted();
      this.checkResponse(response);
      // Some responses finish without visible text (e.g. reasoning consumes the budget).
      // One bounded, tool-free continuation prevents these from silently losing a reply.
      if (playerRequest && !response.output_text.trim()) {
        const outstanding = response.output.filter((item): item is ResponseFunctionToolCall => item.type === 'function_call');
        const input: ResponseInputItem[] = outstanding.map((call) => ({
          type: 'function_call_output', call_id: call.call_id,
          output: JSON.stringify({ success: false, reason: 'Tool round limit reached; this action was not executed.' })
        }));
        input.push({ role: 'developer', content: 'Give the player a short final reply now. Do not claim unexecuted actions succeeded.' });
        response = await client.responses.create({
          model: this.model, instructions: instructions + (clientControl ? playerControlContinuation(0) : ''), previous_response_id: response.id, input,
          tools, tool_choice: 'none', parallel_tool_calls: false, max_output_tokens: 2400, store: true
        }, { signal });
        signal.throwIfAborted();
        this.checkResponse(response);
      }
      let text = response.output_text.trim();
      if (playerRequest && !text) {
        this.logger.warn({ stage: 'planning', model: this.model, responseId: response.id, status: response.status, incomplete: response.incomplete_details }, 'Planner returned no reply text');
        text = "I heard you, but I couldn't finish my response. Please try again.";
      }
      this.logger.info({ stage: 'planning', model: this.model, responseId: response.id, status: response.status, replyCharacters: text.length, toolCalls, channel: event.data?.channel }, 'AI response completed');
      return { text, responseId: response.id, toolCalls, toolNames };
    } catch (error) {
      if (!signal.aborted) this.logger.error({ error, stage: 'planning', model: this.model }, 'OpenAI planning failed');
      throw new Error(`OpenAI planning failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  private checkResponse(response: Response): void {
    if (response.error || response.status === 'failed') {
      throw Object.assign(new Error(response.error?.message ?? 'Response generation failed'), {
        code: response.error?.code, responseId: response.id
      });
    }
  }
}

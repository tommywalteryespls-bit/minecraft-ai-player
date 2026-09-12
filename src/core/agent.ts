import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import type { MinecraftEvent, WorldState } from '../minecraft/types.js';
import type { MemoryManager } from '../memory/memoryManager.js';
import { JournalService } from '../memory/journal.js';
import type { Planner, PlannerResult } from '../ai/planner.js';
import type { VoiceManager } from '../voice/voiceManager.js';
import type { ActionScheduler } from './actionScheduler.js';
import { AgentState } from './agentState.js';
import type { AgentEvent, AgentEventType } from './events.js';
import type { ReflexController } from './reflexes.js';
import type { ExperimentTracker } from '../memory/experiment.js';
import { Mutex } from '../utils/mutex.js';
import { errorMessage } from '../utils/errors.js';
import type { BrowserVoiceReply } from '../voice/browserTypes.js';
import { isStopCommand } from '../voice/stopCommand.js';

export class AutonomousAgent {
  readonly state = new AgentState();
  private autonomyEnabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly conversations = new Mutex();
  private pendingMessages = 0;
  private conversationGeneration = 0;
  private conversationAbort = new AbortController();
  private userStopSerial = 0;

  constructor(
    private readonly minecraft: MinecraftAgent,
    private readonly planner: Planner,
    private readonly memory: MemoryManager,
    private readonly journal: JournalService,
    private readonly experiment: ExperimentTracker,
    private readonly voice: VoiceManager,
    private readonly scheduler: ActionScheduler,
    private readonly reflexes: ReflexController,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    autonomousForServer: boolean,
    private readonly commandOnly = false
  ) {
    this.autonomyEnabled = !commandOnly && config.autonomousEnabled && autonomousForServer;
  }

  start(): void {
    if (this.state.running) return;
    this.state.running = true;
    this.state.currentServerId = this.minecraft.serverId;
    this.unsubscribe = this.minecraft.subscribe((event) => this.handleMinecraftEvent(event));
    if (!this.commandOnly) this.reflexes.start();
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.state.shuttingDown = true;
    this.state.running = false;
    this.conversationGeneration += 1;
    this.conversationAbort.abort();
    this.planner.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.reflexes.stop();
    this.voice.close();
    await this.scheduler.stop();
  }

  setAutonomy(enabled: boolean): void {
    if (this.commandOnly && enabled) throw new Error('Fabric player control is command-only; autonomous behavior is disabled');
    this.autonomyEnabled = enabled;
    this.logger.info({ enabled }, 'Autonomous thinking changed');
  }

  async thinkNow(summary = 'Developer requested an immediate high-level decision'): Promise<PlannerResult> {
    if (this.commandOnly) throw new Error('Fabric player control requires an explicit voice command');
    return this.reason({
      type: 'AUTONOMOUS_TICK',
      serverId: this.minecraft.serverId,
      timestamp: new Date().toISOString(),
      summary
    });
  }

  async follow(username: string): Promise<void> {
    await this.scheduler.schedule('developer_follow', 'FOLLOWING', 40, this.config.actionTimeoutMs, () => this.minecraft.followPlayer(username));
  }

  voiceStatus(): Record<string, unknown> {
    return {
      ...this.voice.status(),
      minecraftConnected: this.minecraft.connected,
      transport: this.minecraft.voiceStatus?.() ?? { connected: false, reason: 'Adapter does not report voice readiness' },
      plannerModel: this.config.openaiModel,
      plannerBusy: this.planner.busy,
      pendingMessages: this.pendingMessages
    };
  }

  async testVoice(text = `Hello, this is ${this.config.aiName}. My voice chat is working.`): Promise<{ success: boolean; reason?: string; stage?: string }> {
    if (!this.state.running || !this.minecraft.connected) return { success: false, reason: 'Connect the bot to Minecraft first' };
    // Deliberately bypass planning and transcription to isolate TTS and game playback.
    return this.voice.speak(text, this.conversationAbort.signal);
  }

  async converseFromBrowser(pcm: Buffer, requestSignal?: AbortSignal): Promise<BrowserVoiceReply> {
    const stopSerial = this.userStopSerial;
    const control = this.minecraft.controlStatus?.();
    if (control && !control.enabled) return { success: false, stage: 'availability', reason: control.reason ?? 'Press F8 in Minecraft to enable voice control' };
    const username = (control?.username ?? this.config.owner).trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) return { success: false, stage: 'availability', reason: 'Set AI_OWNER to your Minecraft username before using browser voice' };
    const generation = this.conversationGeneration;
    const signal = requestSignal ? AbortSignal.any([this.conversationAbort.signal, requestSignal]) : this.conversationAbort.signal;
    if (!this.canReply(generation)) return { success: false, stage: 'availability', reason: 'Connect the bot to Minecraft first' };
    if (pcm.length < 9600 || pcm.length > 48_000 * 2 * 20 || pcm.length % 2) return { success: false, stage: 'availability', reason: 'Record between 0.1 and 20 seconds of mono 48 kHz PCM audio' };
    if (this.pendingMessages >= 20) return { success: false, stage: 'availability', reason: 'Conversation queue is full; please try again' };
    this.pendingMessages += 1;
    let stage: NonNullable<BrowserVoiceReply['stage']> = 'availability';
    let transcript: string | undefined;
    let reply: string | undefined;
    let tools: string[] | undefined;
    const check = () => {
      signal.throwIfAborted();
      if (!this.canReply(generation)) throw new Error('Minecraft connection changed; please try again');
    };
    try {
      return await this.conversations.runExclusive(async () => {
        check();
        stage = 'transcription';
        transcript = await this.voice.transcribeBrowser(pcm, signal);
        check();
        if (!transcript.trim()) return { success: false, stage, reason: 'No speech recognized; please try again' };
        if (this.commandOnly && isStopCommand(transcript, this.config.aiName)) {
          await this.stopBrowserTask();
          return { success: true, stopped: true, transcript, reply: 'Stopped.' };
        }
        stage = 'planning';
        const event: MinecraftEvent = { type: 'PLAYER_SPOKE', serverId: this.minecraft.serverId,
          timestamp: new Date().toISOString(), username, message: transcript, data: { transport: 'browser' } };
        const result = await this.planPlayerMessage(event, 'voice', transcript, signal);
        check();
        reply = result.text.slice(0, 2000).trim();
        tools = result.toolNames;
        stage = 'tts';
        const audio = await this.voice.generateSpeech(reply, signal);
        check();
        // Browser playback is not acknowledged here: record the accompanying text, not successful audible delivery.
        this.memory.recordConversation({ serverId: event.serverId, username, channel: 'text', direction: 'outgoing', message: reply, day: this.state.lastWorldState?.day });
        this.logger.info({ transport: 'browser', stage: 'tts', username, bytes: audio.length }, 'Browser voice reply prepared');
        return { success: true, transcript, reply, tools, mimeType: 'audio/mpeg', audioBase64: audio.toString('base64') };
      });
    } catch (error) {
      if (signal.aborted || !this.canReply(generation)) return this.userStopSerial !== stopSerial
        ? { success: true, stopped: true, reason: 'Voice task cancelled' }
        : { success: false, stage: 'availability', reason: 'Voice request cancelled; actions already started may still be running' };
      this.logger.warn({ stage, transport: 'browser', error }, 'Browser voice turn failed');
      return { success: false, stage, reason: errorMessage(error), transcript, reply, tools };
    } finally {
      this.pendingMessages -= 1;
    }
  }

  /** Out-of-band stop: must not wait for the conversation/planner mutex or an API response. */
  async stopBrowserTask(): Promise<void> {
    this.userStopSerial += 1;
    this.conversationGeneration += 1;
    this.conversationAbort.abort();
    this.conversationAbort = new AbortController();
    this.planner.cancel();
    // ACK-started follow/walk may outlive the scheduler operation, so always cancel the adapter too.
    await Promise.all([this.scheduler.stop(), this.minecraft.cancelCurrentAction('Player requested stop')]);
  }

  /** Transcribe busy speech separately. It can stop a task, never launch another one. */
  async interruptFromBrowser(pcm: Buffer, requestSignal?: AbortSignal): Promise<BrowserVoiceReply> {
    if (!this.commandOnly || !this.config.fabricUnrestricted) {
      return { success: false, stage: 'availability', reason: 'Spoken interruption requires unrestricted Fabric control' };
    }
    if (!this.state.running || !this.minecraft.connected) {
      return { success: false, stage: 'availability', reason: 'Minecraft is not connected' };
    }
    if (pcm.length < 9600 || pcm.length > 48_000 * 2 * 20 || pcm.length % 2) {
      return { success: false, stage: 'availability', reason: 'Record between 0.1 and 20 seconds of mono 48 kHz PCM audio' };
    }
    const generation = this.conversationGeneration;
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.conversationAbort.signal]) : this.conversationAbort.signal;
    try {
      signal.throwIfAborted();
      const transcript = await this.voice.transcribeBrowser(pcm, signal);
      signal.throwIfAborted();
      if (!this.canReply(generation)) return { success: false, stage: 'availability', reason: 'Task session changed' };
      if (!isStopCommand(transcript, this.config.aiName)) {
        return { success: true, stopped: false, transcript, reply: 'Task continues. Say “stop” to cancel it.' };
      }
      await this.stopBrowserTask();
      return { success: true, stopped: true, transcript, reply: 'Stopped.' };
    } catch (error) {
      return { success: false, stage: signal.aborted ? 'availability' : 'transcription',
        reason: signal.aborted ? 'Stop request cancelled because the session changed' : errorMessage(error) };
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const world = this.minecraft.connected ? await this.minecraft.getWorldState() : null;
    return {
      running: this.state.running,
      autonomous: this.autonomyEnabled,
      plannerBusy: this.planner.busy,
      pendingMessages: this.pendingMessages,
      schedulerState: this.scheduler.currentState,
      serverId: this.minecraft.serverId,
      connected: this.minecraft.connected,
      world
    };
  }

  private scheduleNextTick(): void {
    if (!this.state.running) return;
    this.timer = setTimeout(async () => {
      if (this.autonomyEnabled && this.minecraft.connected && !this.planner.busy && this.pendingMessages === 0) {
        await this.thinkNow().catch((error) => this.logger.error({ error }, 'Autonomous tick failed'));
      }
      this.scheduleNextTick();
    }, this.config.thinkIntervalMs);
    this.timer.unref();
  }

  private async handleMinecraftEvent(event: MinecraftEvent): Promise<void> {
    if (!this.state.running) return;
    this.logger.info({ type: event.type, serverId: event.serverId }, 'Minecraft event');
    if (event.type === 'SERVER_DISCONNECTED' || event.type === 'CONTROL_DISABLED') {
      this.conversationGeneration += 1;
      this.conversationAbort.abort();
      this.conversationAbort = new AbortController();
      this.planner.cancel();
      if (this.commandOnly) await this.scheduler.stop();
    }
    // Other players' chat and world events must never drive the user's Fabric character.
    if (this.commandOnly) return;
    if (event.type === 'CHAT_MESSAGE' && event.username && event.message) {
      await this.queuePlayerMessage(event, 'text');
      return;
    }
    if (event.type === 'PLAYER_SPOKE' && event.audio) {
      await this.queuePlayerMessage(event, 'voice');
      return;
    }
    if (event.type === 'NEW_DAY') {
      const previousDay = Number(event.data?.previousDay ?? 0);
      if (previousDay >= 0) {
        const entry = await this.journal.closeDay(event.serverId, previousDay);
        this.logger.info({ serverId: event.serverId, day: entry.day }, 'Daily journal written');
        if (this.config.experimentMode === '100_days' && previousDay >= 99) {
          const file = await this.experiment.finish100Days(event.serverId);
          if (file) this.logger.info({ file }, '100-day experiment summary written');
        }
      }
    }
    if (event.type === 'DEATH') {
      const captured = event.data?.worldState;
      const state = isWorldState(captured) ? captured : this.state.lastWorldState;
      if (state) this.memory.recordDeath(state, event.message ?? 'Unknown cause');
    }
    if (this.minecraft.connected) {
      try {
        this.state.updateWorld(await this.minecraft.getWorldState());
      } catch {
        // The connection may have ended between the event and state request.
      }
    }
    const mapped = mapEvent(event);
    this.memory.recordEvent({ serverId: event.serverId, type: mapped.type, summary: mapped.summary, day: this.state.lastWorldState?.day, importance: eventImportance(event.type), data: event.data });
    if (shouldTriggerReasoning(event.type) && !this.planner.busy && this.pendingMessages === 0) {
      await this.reason(mapped).catch((error) => this.logger.error({ error }, 'Event-triggered reasoning failed'));
    }
  }

  private async queuePlayerMessage(event: MinecraftEvent, channel: 'text' | 'voice'): Promise<void> {
    if (this.pendingMessages >= 20) {
      this.logger.warn({ stage: 'conversation', channel, pendingMessages: this.pendingMessages }, 'Conversation queue full');
      if (this.config.voiceTextFallback && this.minecraft.connected) {
        await this.minecraft.sayText('I have too many messages waiting. Please try again shortly.');
      }
      return;
    }
    const generation = this.conversationGeneration;
    this.pendingMessages += 1;
    this.logger.info({ channel, pendingMessages: this.pendingMessages }, 'Player message queued');
    try {
      await this.conversations.runExclusive(async () => {
        if (!this.canReply(generation)) return;
        let message = event.message ?? '';
        if (channel === 'voice') {
          try {
            message = await this.voice.transcribe(event.audio!);
          } catch (error) {
            if (this.canReply(generation)) this.logger.warn({ error, stage: 'transcription', model: this.config.transcribeModel }, 'Voice transcription failed');
            return;
          }
          this.logger.info({ stage: 'transcription', characters: message.length, username: event.username }, 'Voice transcription completed');
        }
        if (message.trim() && this.canReply(generation)) await this.handlePlayerMessage(event, channel, message, generation);
      });
    } catch (error) {
      if (this.canReply(generation)) this.logger.error({ error, stage: 'conversation', channel }, 'Conversation handling failed');
    } finally {
      this.pendingMessages -= 1;
    }
  }

  private canReply(generation: number): boolean {
    return this.state.running && this.minecraft.connected && generation === this.conversationGeneration;
  }

  private async planPlayerMessage(event: MinecraftEvent, channel: 'text' | 'voice', message: string, signal?: AbortSignal): Promise<PlannerResult> {
    const username = event.username ?? 'unknown player';
    const state = await this.minecraft.getWorldState();
    signal?.throwIfAborted();
    this.state.updateWorld(state);
    this.memory.touchPlayer({
      serverId: event.serverId,
      username,
      uuid: event.uuid,
      interaction: `${channel}: ${message}`
    });
    this.memory.recordConversation({ serverId: event.serverId, username, channel, direction: 'incoming', message, day: state.day });
    return this.reason({
        type: 'PLAYER_SPOKE',
        serverId: event.serverId,
        timestamp: event.timestamp,
        summary: `${username} said via ${channel}: ${message}`,
        data: { username, uuid: event.uuid, channel, message, distance: event.distance, position: event.position, transport: event.data?.transport }
      }, signal);
  }

  private async handlePlayerMessage(event: MinecraftEvent, channel: 'text' | 'voice', message: string, generation: number): Promise<void> {
    const username = event.username ?? 'unknown player';
    let result: PlannerResult;
    try {
      result = await this.planPlayerMessage(event, channel, message, this.conversationAbort.signal);
    } catch (error) {
      if (!this.canReply(generation)) return;
      this.logger.error({ error, stage: 'planning', channel, model: this.config.openaiModel }, 'Player reply planning failed');
      if (channel === 'voice' && this.config.voiceTextFallback) {
        await this.minecraft.sayText("I heard you, but I couldn't generate a reply. Please try again.");
      }
      return;
    }
    if (!this.canReply(generation)) return;
    const reply = result.text.slice(0, channel === 'text' ? 240 : 2000).trim();
    if (!reply) return;
    let deliveredChannel = channel;
    if (channel === 'voice') {
      const spoken = await this.voice.speak(reply, this.conversationAbort.signal);
      if (!this.canReply(generation)) return;
      if (!spoken.success) {
        this.logger.warn({ stage: 'voice-output', reason: spoken.reason }, 'Voice reply delivery failed');
        if (!this.config.voiceTextFallback) return;
        const fallback = await this.minecraft.sayText(reply.slice(0, 240));
        if (!fallback.success) {
          this.logger.warn({ stage: 'text-fallback', reason: fallback.reason }, 'Voice text fallback failed');
          return;
        }
        deliveredChannel = 'text';
      }
    } else if (!result.toolNames.includes('say')) {
      await this.minecraft.sayText(reply);
    }
    this.memory.recordConversation({ serverId: event.serverId, username, channel: deliveredChannel, direction: 'outgoing', message: deliveredChannel === 'text' ? reply.slice(0, 240) : reply, day: this.state.lastWorldState?.day });
  }

  private async reason(event: AgentEvent, signal?: AbortSignal): Promise<PlannerResult> {
    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY is not configured');
    this.state.lastThinkAt = Date.now();
    const result = await this.planner.think(event, signal);
    this.state.lastResponseId = result.responseId;
    return result;
  }
}

function mapEvent(event: MinecraftEvent): AgentEvent {
  const type = (event.type === 'CHAT_MESSAGE' ? 'PLAYER_SPOKE' : event.type) as AgentEventType;
  return {
    type,
    serverId: event.serverId,
    timestamp: event.timestamp,
    summary: event.message ?? `${event.type} occurred`,
    data: {
      ...event.data,
      username: event.username,
      uuid: event.uuid,
      position: event.position,
      distance: event.distance
    }
  };
}

function shouldTriggerReasoning(type: MinecraftEvent['type']): boolean {
  return ['DAMAGE_TAKEN', 'DEATH', 'RESPAWN', 'NEW_DAY', 'PLAYER_APPROACHED', 'SERVER_CONNECTED'].includes(type);
}

function eventImportance(type: MinecraftEvent['type']): number {
  if (type === 'DEATH') return 1;
  if (type === 'RESPAWN' || type === 'NEW_DAY') return 0.8;
  if (type === 'DAMAGE_TAKEN') return 0.6;
  return 0.4;
}

function isWorldState(value: unknown): value is WorldState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<WorldState>;
  return typeof state.serverId === 'string'
    && typeof state.dimension === 'string'
    && typeof state.day === 'number'
    && typeof state.position?.x === 'number'
    && Boolean(state.inventory)
    && Array.isArray(state.environmentalThreats);
}

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pino from 'pino';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import type { AppConfig } from '../src/config.js';
import { Planner, type PlannerResult } from '../src/ai/planner.js';
import type { ContextBuilder } from '../src/ai/contextBuilder.js';
import type { OpenAIService } from '../src/ai/openai.js';
import { ToolExecutor } from '../src/ai/toolExecutor.js';
import type { AgentEvent } from '../src/core/events.js';
import { ActionScheduler } from '../src/core/actionScheduler.js';
import { AutonomousAgent } from '../src/core/agent.js';
import { TestMinecraftAgent } from '../src/minecraft/adapters/test/TestMinecraftAgent.js';
import type { ActionResult } from '../src/minecraft/types.js';
import { isStopCommand } from '../src/voice/stopCommand.js';

const logger = pino({ level: 'silent' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, message = 'Operation did not settle without waiting for the running task'): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 1000); })]); }
  finally { clearTimeout(timer); }
}
function response(index: number, tool = true): Response {
  return { id: `response-${index}`, status: 'completed', error: null, incomplete_details: null,
    output_text: tool ? '' : 'The requested work is complete.',
    output: tool ? [{ type: 'function_call', name: 'inspect_surroundings', call_id: `call-${index}`, arguments: '{}' }] : [] } as Response;
}
const playerEvent: AgentEvent = {
  type: 'PLAYER_SPOKE', serverId: 'fabric-continuous', timestamp: '2026-09-05T00:00:00.000Z',
  summary: 'TestPlayer asked for a multi-step task', data: { username: 'TestPlayer', channel: 'voice', message: 'Complete the requested task' }
};

function plannerFixture(handler: (index: number, request: ResponseCreateParamsNonStreaming, signal: AbortSignal) => Promise<Response>, clientControl = true,
  execute?: (name: string, args: string, signal: AbortSignal) => Promise<ActionResult>) {
  const requests: ResponseCreateParamsNonStreaming[] = [];
  const executions: string[] = [];
  const openai = { requireClient: () => ({ responses: { create: async (request: ResponseCreateParamsNonStreaming, options: { signal: AbortSignal }) => {
    requests.push(request); return handler(requests.length - 1, request, options.signal);
  } } }) } as unknown as OpenAIService;
  const context = { build: async () => ({ currentServer: 'fabric-continuous', worldState: { day: 1 } }) } as unknown as ContextBuilder;
  const executor = {
    isClientControl: () => clientControl, isUnrestrictedControl: () => clientControl,
    execute: async (name: string, args: string, signal: AbortSignal): Promise<ActionResult> => {
      signal.throwIfAborted(); executions.push(name); return execute ? execute(name, args, signal) : { success: true, action: name };
    }
  } as unknown as ToolExecutor;
  return { planner: new Planner(openai, context, executor, logger, 'Astra', 'TestPlayer', 'mock-model', 6, true), requests, executions };
}

test('continuous Fabric planning exceeds six tool rounds and ends when the requested task completes', async (t) => {
  const f = plannerFixture(async (index) => response(index, index < 9));
  t.after(() => f.planner.close());
  const result = await bounded(f.planner.think(playerEvent));
  assert.equal(f.executions.length, 9); assert.equal(result.toolCalls, 9);
  assert.equal(f.requests.length, 10);
  assert.ok(f.requests.every((request) => request.tool_choice === 'auto'), 'no artificial final round is imposed');
  assert.equal(result.text, 'The requested work is complete.');
  assert.equal(f.planner.busy, false);
});

test('unrestricted setting does not remove the tool budget for non-Fabric controllers', async (t) => {
  const f = plannerFixture(async (index, request) => response(index, request.tool_choice !== 'none'), false);
  t.after(() => f.planner.close());
  const result = await bounded(f.planner.think(playerEvent));
  assert.equal(result.toolCalls, 6); assert.equal(f.executions.length, 6);
  assert.equal(f.requests.at(-1)?.tool_choice, 'none');
});

test('continuous planning aborts after more than six rounds without another action or API continuation', async (t) => {
  const waiting = deferred<void>();
  const f = plannerFixture(async (index, _request, signal) => {
    if (index !== 8) return response(index);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      waiting.resolve();
    });
  });
  t.after(() => f.planner.close());
  const controller = new AbortController();
  const running = f.planner.think(playerEvent, controller.signal);
  const rejection = assert.rejects(running, /abort|stop/i);
  await bounded(waiting.promise);
  assert.equal(f.executions.length, 8);
  controller.abort(new Error('Stop requested'));
  await bounded(rejection);
  assert.equal(f.requests.length, 9); assert.equal(f.executions.length, 8); assert.equal(f.planner.busy, false);
});

test('an until-stop mining task does not finish on a progress-only reply and its continuation wait is abortable', async (t) => {
  const progress = deferred<void>();
  const f = plannerFixture(async (index) => {
    assert.equal(index, 0, 'aborting the continuation wait must prevent another API request');
    progress.resolve();
    return { ...response(index, false), output_text: 'I am checking the next stone block.' };
  });
  t.after(() => f.planner.close());
  const controller = new AbortController();
  const event = { ...playerEvent, data: { ...playerEvent.data, message: 'Mine stone until I say stop' } };
  const running = f.planner.think(event, controller.signal);
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(running, /abort|stop/i);
  await bounded(progress.promise);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, 'a no-tool progress reply is not completion of an explicitly continuing task');
  assert.equal(f.planner.busy, true); assert.equal(f.requests.length, 1); assert.equal(f.executions.length, 0);
  controller.abort(new Error('Stop requested while waiting'));
  await bounded(rejection, 'The two-second continuation wait did not respond promptly to cancellation');
  assert.equal(f.requests.length, 1); assert.equal(f.executions.length, 0); assert.equal(f.planner.busy, false);
});

test('acknowledged until-stopped following lets the planner finish without repeating the local action', async (t) => {
  const f = plannerFixture(async (index) => {
    if (index === 0) return { ...response(index), output: [{
      type: 'function_call', name: 'follow_player', call_id: 'follow-until-stop', arguments: '{"username":"Friend"}'
    }] } as Response;
    assert.equal(index, 1, 'following continues locally; it must not launch another planner loop');
    return { ...response(index, false), output_text: 'Following Friend until you say stop.' };
  }, true, async (name) => ({ success: true, action: name, data: { started: true, untilStopped: true } }));
  t.after(() => f.planner.close());
  const event = { ...playerEvent, data: { ...playerEvent.data, message: 'Follow Friend until I say stop' } };
  const result = await bounded(f.planner.think(event));
  assert.equal(result.text, 'Following Friend until you say stop.');
  assert.equal(result.toolCalls, 1); assert.deepEqual(f.executions, ['follow_player']);
  assert.equal(f.requests.length, 2); assert.equal(f.planner.busy, false);
});

class ControlledMinecraft extends TestMinecraftAgent {
  cancellations: string[] = [];
  controlStatus() { return { enabled: true, username: 'TestPlayer', worldId: 'test-world' }; }
  override async cancelCurrentAction(reason?: string): Promise<void> { this.cancellations.push(reason ?? 'cancelled'); }
}

test('zero scheduler timeout has no deadline and request abort cancels active and queued work', async (t) => {
  const minecraft = new ControlledMinecraft('fabric-continuous');
  const scheduler = new ActionScheduler(minecraft, logger); t.after(() => scheduler.stop());
  const controller = new AbortController();
  const started = deferred<void>(); const release = deferred<ActionResult>();
  let operationSignal: AbortSignal | undefined, queuedStarts = 0;
  const active = scheduler.schedule('continuous-task', 'MINING', 20, 0, async (signal) => {
    operationSignal = signal; started.resolve(); return release.promise;
  }, controller.signal);
  await started.promise;
  const queued = scheduler.schedule('queued-task', 'MOVING', 20, 0, async () => {
    queuedStarts++; return { success: true, action: 'queued-task' };
  }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(scheduler.busy, true); assert.equal(operationSignal?.aborted, false);
  assert.equal(minecraft.cancellations.length, 0, 'timeout=0 must not schedule an immediate cancellation');
  controller.abort(new Error('Player said stop'));
  const results = await bounded(Promise.all([active, queued]));
  assert.ok(results.every((result) => !result.success));
  assert.equal(operationSignal?.aborted, true); assert.equal(queuedStarts, 0);
  assert.ok(minecraft.cancellations.length >= 1);
  release.resolve({ success: true, action: 'continuous-task' });
});

test('aborting a queued request leaves an unrelated running action alone', async (t) => {
  const minecraft = new ControlledMinecraft('fabric-continuous');
  const scheduler = new ActionScheduler(minecraft, logger); t.after(() => scheduler.stop());
  const release = deferred<ActionResult>(); const started = deferred<void>();
  const activeController = new AbortController(), queuedController = new AbortController();
  let queuedStarts = 0;
  const active = scheduler.schedule('first', 'MOVING', 20, 0, async () => { started.resolve(); return release.promise; }, activeController.signal);
  await started.promise;
  const queued = scheduler.schedule('second', 'MOVING', 20, 0, async () => { queuedStarts++; return { success: true, action: 'second' }; }, queuedController.signal);
  queuedController.abort();
  assert.equal((await bounded(queued)).success, false);
  assert.equal(minecraft.cancellations.length, 0); assert.equal(scheduler.busy, true); assert.equal(queuedStarts, 0);
  release.resolve({ success: true, action: 'first' });
  assert.equal((await bounded(active)).success, true);
});

test('ToolExecutor removes deadlines only for unrestricted client control and forwards request cancellation', async (t) => {
  for (const [clientControl, unrestricted, expectedTimeout] of [[true, true, 0], [true, false, 1000], [false, true, 1000]] as const) {
    const minecraft = clientControl ? new ControlledMinecraft('fabric-continuous') : new TestMinecraftAgent('test-controller');
    const scheduler = new ActionScheduler(minecraft, logger);
    const calls: Array<Parameters<ActionScheduler['schedule']>> = [];
    t.mock.method(scheduler, 'schedule', async (...args: Parameters<ActionScheduler['schedule']>) => {
      calls.push(args); return { success: true, action: args[0] };
    });
    type Args = ConstructorParameters<typeof ToolExecutor>;
    const executor = new ToolExecutor(minecraft, { recordAction: () => {} } as unknown as Args[1], scheduler,
      {} as Args[3], {} as Args[4], { fabricUnrestricted: unrestricted, actionTimeoutMs: 1000 } as AppConfig);
    const controller = new AbortController();
    assert.equal(executor.isUnrestrictedControl(), clientControl && unrestricted);
    assert.equal((await executor.execute('follow_player', '{"username":"Friend"}', controller.signal)).success, true);
    assert.equal(calls.length, 1); assert.equal(calls[0]?.[3], expectedTimeout);
    assert.equal(calls[0]?.[5], controller.signal, 'HTTP/request cancellation must reach the running game action');
  }
});

async function agentFixture(t: TestContext) {
  const minecraft = new ControlledMinecraft('fabric-continuous'); await minecraft.connect();
  const scheduler = new ActionScheduler(minecraft, logger);
  const started = deferred<void>(), release = deferred<PlannerResult>();
  let planningCalls = 0, plannerCancels = 0, generated = 0;
  let planningSignal: AbortSignal | undefined;
  const transcripts = ['Mine nine stone blocks'];
  const planner = {
    busy: true,
    think: async (_event: AgentEvent, signal?: AbortSignal) => {
      planningCalls++; planningSignal = signal; started.resolve(); return release.promise;
    }, cancel: () => { plannerCancels++; }, close: () => {}
  };
  const voice = {
    transcribeBrowser: async (_audio: Buffer, signal?: AbortSignal) => { signal?.throwIfAborted(); return transcripts.shift() ?? ''; },
    generateSpeech: async () => { generated++; return Buffer.from('mock speech'); },
    close: () => {}, status: () => ({ enabled: true })
  };
  const config = { aiName: 'Astra', owner: 'TestPlayer', openaiApiKey: 'mock-only', openaiModel: 'mock-model',
    fabricUnrestricted: true, voiceEnabled: true, autonomousEnabled: false, thinkIntervalMs: 60_000 } as AppConfig;
  type Args = ConstructorParameters<typeof AutonomousAgent>;
  const agent = new AutonomousAgent(minecraft, planner as unknown as Args[1], {
    touchPlayer: () => {}, recordConversation: () => {}, recordEvent: () => {}
  } as unknown as Args[2], {} as Args[3], {} as Args[4], voice as unknown as Args[5], scheduler,
  { start: () => {}, stop: () => {} } as Args[7], config, logger, false, true);
  agent.start();
  t.after(async () => {
    release.resolve({ text: 'Finished.', responseId: 'cleanup', toolCalls: 0, toolNames: [] });
    await agent.stop(); await minecraft.disconnect();
  });
  return { agent, minecraft, scheduler, started, release, transcripts,
    planningCalls: () => planningCalls, plannerCancels: () => plannerCancels,
    planningSignal: () => planningSignal, generated: () => generated };
}

test('spoken stop bypasses a hung planning conversation and prevents its late reply', async (t) => {
  const f = await agentFixture(t);
  const task = f.agent.converseFromBrowser(Buffer.alloc(9600));
  await bounded(f.started.promise);
  f.transcripts.push('Astra, stop.');
  const stopped = await bounded(f.agent.interruptFromBrowser(Buffer.alloc(9600)));
  assert.equal(stopped.success, true); assert.equal(stopped.stopped, true);
  assert.equal(stopped.reply, 'Stopped.');
  assert.equal(f.planningCalls(), 1); assert.ok(f.plannerCancels() >= 1);
  assert.equal(f.planningSignal()?.aborted, true); assert.ok(f.minecraft.cancellations.length >= 1);
  assert.equal(f.generated(), 0, 'stop response does not wait for TTS or the task mutex');
  f.release.resolve({ text: 'Stale finished message', responseId: 'late', toolCalls: 9, toolNames: ['mine_block'] });
  const cancelled = await bounded(task);
  assert.equal(cancelled.stopped, true);
  assert.equal(cancelled.audioBase64, undefined);
  assert.notEqual(cancelled.reply, 'Stale finished message');
  assert.equal(f.generated(), 0);
});

test('non-stop interrupt speech neither replans nor cancels the running task', async (t) => {
  const f = await agentFixture(t);
  const task = f.agent.converseFromBrowser(Buffer.alloc(9600));
  await bounded(f.started.promise);
  f.transcripts.push('Do not stop mining.');
  const ignored = await bounded(f.agent.interruptFromBrowser(Buffer.alloc(9600)));
  assert.equal(ignored.success, true); assert.equal(ignored.stopped, false);
  assert.equal(f.planningCalls(), 1); assert.equal(f.plannerCancels(), 0);
  assert.equal(f.minecraft.cancellations.length, 0); assert.equal(f.planningSignal()?.aborted, false);
  f.release.resolve({ text: 'The requested work is finished.', responseId: 'finished', toolCalls: 9, toolNames: ['mine_block'] });
  assert.equal((await bounded(task)).success, true); assert.equal(f.generated(), 1);
});

test('browser Stop releases acknowledged follow inputs even when no scheduler action is pending', async (t) => {
  const f = await agentFixture(t);
  const following = await f.scheduler.schedule('follow_player', 'FOLLOWING', 20, 0,
    async () => ({ success: true, action: 'follow_player', data: { started: true } }));
  assert.equal(following.success, true); assert.equal(f.scheduler.busy, false);
  await bounded(f.agent.stopBrowserTask());
  assert.ok(f.minecraft.cancellations.length >= 1, 'cancellation must reach the client after an early following acknowledgement');
});

test('an idle direct spoken stop bypasses planning and speech generation', async (t) => {
  const f = await agentFixture(t);
  f.transcripts.splice(0, f.transcripts.length, 'Please stop.');
  const stopped = await bounded(f.agent.converseFromBrowser(Buffer.alloc(9600)));
  assert.equal(stopped.success, true); assert.equal(stopped.stopped, true); assert.equal(stopped.reply, 'Stopped.');
  assert.equal(f.planningCalls(), 0); assert.equal(f.generated(), 0); assert.ok(f.minecraft.cancellations.length >= 1);
});

test('direct stop matching rejects negations and incidental mentions instead of interrupting unrelated speech', () => {
  assert.equal(isStopCommand('stop', 'Astra'), true);
  assert.equal(isStopCommand('Astra, stop.', 'Astra'), true);
  for (const text of ['Do not stop.', "Don't stop mining.", 'Never stop.', "Don't cancel.", 'Keep going.', 'Unstoppable.',
    'Where is the next stop?', 'Stop after three blocks.', 'Stop if you see lava.', 'Cancel after finishing.',
    'Cancel the task after mining.', 'I said stop earlier.', '']) {
    assert.equal(isStopCommand(text, 'Astra'), false, text);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Logger } from 'pino';
import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall } from 'openai/resources/responses/responses';
import type { ContextBuilder } from '../src/ai/contextBuilder.js';
import type { OpenAIService } from '../src/ai/openai.js';
import { Planner } from '../src/ai/planner.js';
import type { ToolExecutor } from '../src/ai/toolExecutor.js';
import type { AgentEvent } from '../src/core/events.js';
import type { ActionResult } from '../src/minecraft/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function response(id: string, text = '', output: Response['output'] = []): Response {
  return { id, output_text: text, output, status: 'completed', error: null, incomplete_details: null } as Response;
}

function call(name: string, id = name, args = '{}'): ResponseFunctionToolCall {
  return { type: 'function_call', name, call_id: id, arguments: args };
}

function event(type: AgentEvent['type'] = 'PLAYER_SPOKE', channel = 'voice'): AgentEvent {
  return {
    type, serverId: 'voice-test', timestamp: '2026-09-05T00:00:00.000Z',
    summary: type === 'PLAYER_SPOKE' ? 'TestPlayer asks: follow me' : 'Check surroundings',
    data: type === 'PLAYER_SPOKE' ? { username: 'TestPlayer', channel, message: 'follow me' } : undefined
  };
}

type Request = ResponseCreateParamsNonStreaming;
type RequestHandler = (request: Request, index: number, signal: AbortSignal) => Promise<Response>;

function fixture(handler: RequestHandler, maxToolRounds = 3, execute?: (name: string, args: string) => Promise<ActionResult>, clientControl = false) {
  const requests: Request[] = [];
  const signals: AbortSignal[] = [];
  const executions: { name: string; args: string }[] = [];
  const contexts: { focus: string; username?: string }[] = [];
  const logs: { level: string; data: Record<string, unknown>; message: string }[] = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level,
    (data: Record<string, unknown>, message: string) => logs.push({ level, data, message })
  ])) as unknown as Logger;
  const openai = {
    requireClient: () => ({ responses: { create: async (request: Request, options: { signal: AbortSignal }) => {
      requests.push(request);
      signals.push(options.signal);
      return handler(request, requests.length - 1, options.signal);
    } } })
  } as unknown as OpenAIService;
  const context = { build: async (focus: string, username?: string) => {
    contexts.push({ focus, username });
    return { currentServer: 'voice-test', worldState: { day: 1 } };
  } } as unknown as ContextBuilder;
  const executor = { isClientControl: () => clientControl, execute: async (name: string, args: string): Promise<ActionResult> => {
    executions.push({ name, args });
    return execute ? execute(name, args) : { success: true, action: name };
  } } as unknown as ToolExecutor;
  return {
    planner: new Planner(openai, context, executor, logger, 'Astra', 'TestPlayer', 'test-model', maxToolRounds),
    requests, signals, executions, contexts, logs
  };
}

test('Fabric uses a top-level explicit-command policy rather than autonomous survival instructions', async () => {
  const f = fixture(async (request) => {
    assert.match(String(request.instructions), /A question or request for status is not permission to act/);
    assert.match(String(request.instructions), /NOT a separate autonomous player/);
    assert.doesNotMatch(String(request.instructions), /act independently/i);
    const movement = request.tools?.find((tool) => tool.type === 'function' && tool.name === 'move_to');
    assert.ok(movement?.type === 'function');
    assert.match(movement.description!, /No pathfinding/);
    assert.match(String(request.instructions), /hotbar food only/);
    return response('r', 'You are standing beside a tree.');
  }, 2, undefined, true);
  await f.planner.think({ ...event(), summary: 'What am I looking at?', data: { username: 'TestPlayer', channel: 'voice', message: 'What am I looking at?' } });
  assert.equal(f.executions.length, 0);
});

test('request-local cancellation prevents tool execution and does not cancel the next player', async () => {
  const started = deferred<void>(), release = deferred<Response>();
  const f = fixture(async (_request, index, signal) => {
    if (index === 0) { started.resolve(); const value = await release.promise; assert.equal(signal.aborted, true); return value; }
    assert.equal(signal.aborted, false); return response('fresh', 'Hello.');
  });
  const controller = new AbortController();
  const first = f.planner.think(event(), controller.signal);
  const rejected = assert.rejects(first, /abort/i);
  await started.promise; controller.abort();
  release.resolve(response('cancelled', '', [call('follow_player')]));
  await rejected; assert.equal(f.executions.length, 0);
  assert.equal((await f.planner.think(event())).text, 'Hello.');
});

test('player voice waits for an autonomous turn and makes that turn finalize at its next tool boundary', async () => {
  const started = deferred<void>();
  const firstResponse = deferred<Response>();
  const f = fixture(async (_request, index) => {
    if (index === 0) { started.resolve(); return firstResponse.promise; }
    if (index === 1) return response('autonomous-done', 'The surroundings are clear.');
    if (index === 2) return response('player-done', 'I am following you.');
    throw new Error('Unexpected additional request');
  });
  const autonomous = f.planner.think(event('AUTONOMOUS_TICK'));
  await started.promise;
  const voice = f.planner.think(event());
  assert.equal(f.planner.busy, true);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.planner.think(event('DAMAGE_TAKEN'))).responseId, null);
  firstResponse.resolve(response('autonomous-tools', '', [call('inspect_surroundings')]));
  const [background, reply] = await Promise.all([autonomous, voice]);
  assert.equal(background.text, 'The surroundings are clear.');
  assert.equal(reply.text, 'I am following you.');
  assert.equal(f.requests[1]?.tool_choice, 'none');
  assert.match(String(f.requests[2]?.input), /TestPlayer asks: follow me/);
  assert.equal(f.contexts[1]?.username, 'TestPlayer');
  assert.equal(f.planner.busy, false);
});

test('voice requests omit say and reject an unexpected say call without sending text chat', async () => {
  const f = fixture(async (_request, index) => index === 0
    ? response('tools', '', [call('say', 'chat', '{"message":"Following you."}'), call('follow_player', 'follow', '{"username":"TestPlayer"}')])
    : response('spoken-reply', 'I am following you.'), 1);
  const result = await f.planner.think(event());
  assert.equal(result.text, 'I am following you.');
  assert.deepEqual(f.executions.map((execution) => execution.name), ['follow_player']);
  for (const request of f.requests) {
    assert.equal(request.tools?.some((tool) => tool.type === 'function' && tool.name === 'say'), false);
  }
  const outputs = f.requests[1]?.input;
  assert.ok(Array.isArray(outputs));
  assert.equal(outputs.length, 2);
  assert.deepEqual(outputs.map((output) => output.type === 'function_call_output' ? output.call_id : null), ['chat', 'follow']);
  const denied = outputs[0];
  assert.ok(denied?.type === 'function_call_output' && typeof denied.output === 'string');
  assert.equal(JSON.parse(denied.output).success, false);
});

test('text requests retain the text-chat say tool', async () => {
  const f = fixture(async () => response('text-reply', 'Hello.'));
  await f.planner.think(event('PLAYER_SPOKE', 'text'));
  assert.equal(f.requests[0]?.tools?.some((tool) => tool.type === 'function' && tool.name === 'say'), true);
});

test('the last allowed tool round submits every result and forces a final reply', async () => {
  const f = fixture(async (_request, index) => {
    if (index === 0) return response('round-one', '', [call('inspect_inventory', 'inventory')]);
    if (index === 1) return response('round-two', '', [call('find_block', 'block'), call('look_at', 'look')]);
    return response('final', 'I found a tree nearby.');
  }, 2);
  const result = await f.planner.think(event());
  assert.equal(result.text, 'I found a tree nearby.');
  assert.equal(result.toolCalls, 3);
  assert.deepEqual(result.toolNames, ['inspect_inventory', 'find_block', 'look_at']);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[1]?.tool_choice, 'auto');
  assert.equal(f.requests[1]?.previous_response_id, 'round-one');
  assert.equal(f.requests[2]?.tool_choice, 'none');
  assert.equal(f.requests[2]?.previous_response_id, 'round-two');
  const outputs = f.requests[2]?.input;
  assert.ok(Array.isArray(outputs));
  assert.deepEqual(outputs.map((output) => output.type === 'function_call_output' ? output.call_id : null), ['block', 'look']);
});

test('an empty voice reply gets exactly one tool-free finalization and a useful fallback if still empty', async () => {
  const f = fixture(async (_request, index) => response(`empty-${index}`));
  const result = await f.planner.think(event());
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]?.tool_choice, 'none');
  assert.equal(f.requests[1]?.previous_response_id, 'empty-0');
  assert.match(result.text, /I heard you/);
  assert.equal(result.responseId, 'empty-1');
  assert.equal(f.logs.filter((entry) => entry.message === 'Planner returned no reply text').length, 1);
});

test('finalization handles unexpected outstanding calls honestly without executing another action', async () => {
  const f = fixture(async (_request, index) => {
    if (index === 0) return response('tool', '', [call('inspect_inventory', 'inventory')]);
    if (index === 1) return response('unexpected-tool', '', [call('mine_block', 'unexecuted')]);
    return response('final', 'I checked my inventory, but did not mine anything.');
  }, 1);
  const result = await f.planner.think(event());
  assert.match(result.text, /did not mine/);
  assert.deepEqual(f.executions.map((execution) => execution.name), ['inspect_inventory']);
  assert.equal(f.requests.length, 3);
  const outputs = f.requests[2]?.input;
  assert.ok(Array.isArray(outputs));
  const output = outputs.find((item) => item.type === 'function_call_output');
  assert.ok(output?.type === 'function_call_output' && typeof output.output === 'string');
  assert.equal(output.call_id, 'unexecuted');
  assert.equal(JSON.parse(output.output).success, false);
  assert.match(JSON.parse(output.output).reason, /not executed/);
  assert.equal(f.requests[2]?.tool_choice, 'none');
});

test('closing the planner aborts current and queued turns before more API or tool calls', async () => {
  const started = deferred<void>();
  const firstResponse = deferred<Response>();
  const f = fixture(async () => { started.resolve(); return firstResponse.promise; });
  const first = f.planner.think(event('AUTONOMOUS_TICK'));
  await started.promise;
  const queued = f.planner.think(event());
  const settled = Promise.allSettled([first, queued]);
  f.planner.close();
  assert.equal(f.signals[0]?.aborted, true);
  firstResponse.resolve(response('late-response', '', [call('follow_player')]));
  assert.deepEqual((await settled).map((result) => result.status), ['rejected', 'rejected']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.executions.length, 0);
  assert.equal(f.planner.busy, false);
  await assert.rejects(f.planner.think(event()), /Planner is closed/);
});

test('disconnect cancellation stops tool continuations and old queued work but permits a new session', async () => {
  const toolStarted = deferred<void>();
  const finishTool = deferred<void>();
  const f = fixture(async (_request, index) => index === 0
    ? response('tools', '', [call('follow_player')])
    : response('new-session', 'Hello again.'), 3, async (name) => {
    toolStarted.resolve();
    await finishTool.promise;
    return { success: true, action: name };
  });
  const active = f.planner.think(event());
  await toolStarted.promise;
  const queued = f.planner.think(event());
  const settled = Promise.allSettled([active, queued]);
  f.planner.cancel();
  finishTool.resolve();
  assert.deepEqual((await settled).map((result) => result.status), ['rejected', 'rejected']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.planner.busy, false);
  assert.equal((await f.planner.think(event())).text, 'Hello again.');
  assert.equal(f.signals[1]?.aborted, false);
});

test('an API failure releases the queue so the next player can receive a reply', async () => {
  const started = deferred<void>();
  const failure = deferred<Response>();
  const f = fixture(async (_request, index) => {
    if (index === 0) { started.resolve(); return failure.promise; }
    return response('recovered', 'I can hear you now.');
  });
  const first = f.planner.think(event('AUTONOMOUS_TICK'));
  await started.promise;
  const queued = f.planner.think(event());
  const settled = Promise.allSettled([first, queued]);
  failure.reject(new Error('temporary API failure'));
  const [failed, recovered] = await settled;
  assert.equal(failed?.status, 'rejected');
  assert.equal(recovered?.status, 'fulfilled');
  if (recovered?.status === 'fulfilled') assert.equal(recovered.value.text, 'I can hear you now.');
  assert.equal(f.planner.busy, false);
  assert.equal(f.logs.filter((entry) => entry.message === 'OpenAI planning failed').length, 1);
});

test('failed responses preserve their error instead of becoming empty speech', async () => {
  const f = fixture(async () => ({
    ...response('failed'), status: 'failed', error: { code: 'server_error', message: 'Upstream failed' }
  } as Response));
  await assert.rejects(f.planner.think(event()), /Upstream failed/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.planner.busy, false);
});

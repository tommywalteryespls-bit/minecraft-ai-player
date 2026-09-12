import assert from 'node:assert/strict';
import test from 'node:test';
import type { Logger } from 'pino';
import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall } from 'openai/resources/responses/responses';
import type { ContextBuilder } from '../src/ai/contextBuilder.js';
import type { OpenAIService } from '../src/ai/openai.js';
import { Planner } from '../src/ai/planner.js';
import { playerControlContinuation, playerControlPrompt } from '../src/ai/prompts.js';
import type { ToolExecutor } from '../src/ai/toolExecutor.js';
import type { AgentEvent } from '../src/core/events.js';
import type { ActionResult } from '../src/minecraft/types.js';

// These scripted Responses fixtures verify planner wiring and its supplied policy.
// They deliberately do not claim to evaluate a live model's judgment or gameplay.
type Request = ResponseCreateParamsNonStreaming;
type Handler = (request: Request, index: number, signal: AbortSignal) => Promise<Response>;

function response(id: string, text = '', output: Response['output'] = []): Response {
  return { id, output_text: text, output, status: 'completed', error: null, incomplete_details: null } as Response;
}

function call(name: string, id: string, args: Record<string, unknown> = {}): ResponseFunctionToolCall {
  return { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) };
}

function mine(id: string): ResponseFunctionToolCall {
  return call('mine_block', id, { block: 'stone', position: null });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function outputs(request: Request): { callId: string; result: ActionResult }[] {
  assert.ok(Array.isArray(request.input));
  return request.input.map((item) => {
    assert.equal(item.type, 'function_call_output');
    assert.ok(item.type === 'function_call_output' && typeof item.output === 'string');
    assert.ok(typeof item.call_id === 'string');
    return { callId: item.call_id, result: JSON.parse(item.output) as ActionResult };
  });
}

function event(message = 'Equip my iron pickaxe and mine three stone blocks.'): AgentEvent {
  return {
    type: 'PLAYER_SPOKE', serverId: 'fabric-test-world', timestamp: '2026-09-05T00:00:00.000Z',
    summary: `TestPlayer asks: ${message}`,
    data: { username: 'TestPlayer', channel: 'voice', message }
  };
}

function fixture(handler: Handler, maxToolRounds = 6,
  execute?: (name: string, args: string, signal: AbortSignal) => Promise<ActionResult>) {
  const requests: Request[] = [];
  const executions: { name: string; args: string }[] = [];
  const logger = { info() {}, warn() {}, error() {} } as unknown as Logger;
  const openai = {
    requireClient: () => ({ responses: { create: async (request: Request, options: { signal: AbortSignal }) => {
      requests.push(request);
      return handler(request, requests.length - 1, options.signal);
    } } })
  } as unknown as OpenAIService;
  const context = { build: async () => ({
    clientControl: { username: 'TestPlayer', enabled: true },
    currentServer: 'fabric-test-world', worldState: { day: 1 }
  }) } as unknown as ContextBuilder;
  const executor = {
    isClientControl: () => true,
    availableToolNames: () => ['equip_item', 'mine_block', 'inspect_surroundings'],
    execute: async (name: string, args: string, signal: AbortSignal): Promise<ActionResult> => {
      executions.push({ name, args });
      return execute ? execute(name, args, signal) : { success: true, action: name };
    }
  } as unknown as ToolExecutor;
  return {
    planner: new Planner(openai, context, executor, logger, 'Astra', 'TestPlayer', 'scripted-test-model', maxToolRounds),
    requests, executions
  };
}

test('Fabric policy permits explicit task sequences and counts confirmed progress without granting autonomy', () => {
  const policy = playerControlPrompt('Astra');
  assert.match(policy, /sequence|multi-step/i);
  assert.match(policy, /requested (?:count|quantity)|count.*(?:requested|confirmed)|confirmed.*count/i);
  assert.match(policy, /progress|remaining/i);
  assert.doesNotMatch(policy, /Prefer one short bounded action/i);
  assert.match(policy, /A question or request for status is not permission to act/);
  assert.match(policy, /NOT a separate autonomous player/);
  assert.match(policy, /F8\/F9/);
  assert.match(policy, /obstacles, drops, or hazards/);
  assert.match(policy, /Never count a failed action/);
  assert.match(policy, /confirmed tool results/);
  assert.match(playerControlContinuation(3), /3/);
  assert.match(playerControlContinuation(3), /continu|remaining|unfinished/i);
  assert.match(playerControlContinuation(0), /partial|incomplete|unfinished|remaining/i);
});

test('Fabric completes a scripted equip plus three-block sequence across sequential responses', async () => {
  const actions = [call('equip_item', 'equip', { item: 'iron_pickaxe', destination: 'hand' }), mine('mine-1'), mine('mine-2'), mine('mine-3')];
  const f = fixture(async (request, index) => {
    assert.ok(String(request.instructions).includes(playerControlContinuation(6 - index)));
    assert.equal(request.tool_choice, 'auto');
    assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.tools?.some((tool) => tool.type === 'function' && tool.name === 'say'), false);
    if (index > 0) {
      assert.equal(request.previous_response_id, `sequence-${index - 1}`);
      assert.deepEqual(outputs(request), [{ callId: actions[index - 1]!.call_id,
        result: { success: true, action: actions[index - 1]!.name, data: { completedStep: index } } }]);
    }
    return index < actions.length
      ? response(`sequence-${index}`, '', [actions[index]!])
      : response('done', 'Equipped your pickaxe and mined all three stone blocks.');
  }, 6, async (name) => ({ success: true, action: name, data: { completedStep: f.executions.length } }));

  const result = await f.planner.think(event());
  assert.equal(result.text, 'Equipped your pickaxe and mined all three stone blocks.');
  assert.deepEqual(result.toolNames, ['equip_item', 'mine_block', 'mine_block', 'mine_block']);
  assert.equal(result.toolCalls, 4);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.executions.map(({ name }) => name), result.toolNames);
});

test('Fabric forwards failed mining results so a scripted final reply reports only confirmed mined blocks', async () => {
  let confirmed = 0;
  const f = fixture(async (request, index) => {
    if (index === 0) return response('first-block', '', [mine('mine-1')]);
    const [previous] = outputs(request);
    assert.ok(previous);
    if (previous.result.action === 'mine_block' && previous.result.success) confirmed += 1;
    if (index === 1) {
      assert.equal(previous.result.success, true);
      return response('second-block', '', [mine('mine-2')]);
    }
    if (index === 2) {
      assert.deepEqual(previous, { callId: 'mine-2', result: {
        success: false, action: 'mine_block', reason: 'No visible stone block within reach'
      } });
      return response('check-reach', '', [call('inspect_surroundings', 'inspect')]);
    }
    assert.equal(previous.callId, 'inspect');
    return response('partial', `Mined ${confirmed} of 3 blocks; the other blocks are out of reach.`);
  }, 6, async (name) => name === 'mine_block' && f.executions.length === 2
    ? { success: false, action: name, reason: 'No visible stone block within reach' }
    : { success: true, action: name });

  const result = await f.planner.think(event('Mine three stone blocks.'));
  assert.equal(result.text, 'Mined 1 of 3 blocks; the other blocks are out of reach.');
  assert.deepEqual(f.executions.map(({ name }) => name), ['mine_block', 'mine_block', 'inspect_surroundings']);
  assert.equal(f.requests.length, 4);
});

test('Fabric preserves the configured tool-round cap and requests a tool-free partial completion report at zero', async () => {
  const f = fixture(async (request, index) => {
    assert.ok(String(request.instructions).includes(playerControlContinuation(2 - index)));
    if (index < 2) {
      assert.equal(request.tool_choice, 'auto');
      return response(`bounded-${index}`, '', [mine(`mine-${index + 1}`)]);
    }
    assert.equal(index, 2);
    assert.equal(request.tool_choice, 'none');
    assert.equal(request.previous_response_id, 'bounded-1');
    assert.deepEqual(outputs(request), [{ callId: 'mine-2', result: { success: true, action: 'mine_block' } }]);
    return response('partial', 'Mined 2 of 3 blocks. This turn reached its action-round limit.');
  }, 2);

  const result = await f.planner.think(event('Mine three stone blocks.'));
  assert.match(result.text, /2 of 3/);
  assert.equal(result.toolCalls, 2);
  assert.equal(f.executions.length, 2);
  assert.equal(f.requests.length, 3);
});

test('Fabric request cancellation between sequence steps prevents a late next action from executing', async () => {
  const continuationStarted = deferred<void>();
  const continuation = deferred<Response>();
  const controller = new AbortController();
  const f = fixture(async (request, index, signal) => {
    if (index === 0) return response('first', '', [mine('mine-1')]);
    assert.equal(index, 1);
    assert.deepEqual(outputs(request), [{ callId: 'mine-1', result: { success: true, action: 'mine_block' } }]);
    continuationStarted.resolve();
    const next = await continuation.promise;
    assert.equal(signal.aborted, true);
    return next;
  });

  const pending = f.planner.think(event('Mine three stone blocks.'), controller.signal);
  const rejected = assert.rejects(pending, /abort/i);
  await continuationStarted.promise;
  controller.abort();
  continuation.resolve(response('late-next-step', '', [mine('mine-2')]));
  await rejected;
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.executions.map(({ name }) => name), ['mine_block']);
  assert.equal(f.planner.busy, false);
});

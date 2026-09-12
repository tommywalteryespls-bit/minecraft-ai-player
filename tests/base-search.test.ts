import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { BaseSearchRunner } from '../src/skills/baseSearch.js';
import { ToolExecutor } from '../src/ai/toolExecutor.js';
import { ActionScheduler } from '../src/core/actionScheduler.js';
import { Planner } from '../src/ai/planner.js';
import { minecraftTools } from '../src/ai/tools.js';
import type { MinecraftAgent } from '../src/minecraft/MinecraftAgent.js';
import type { ActionResult, Position, WorldState } from '../src/minecraft/types.js';
import type { MemoryManager } from '../src/memory/memoryManager.js';
import type { GoalRecord } from '../src/memory/types.js';
import type { AppConfig } from '../src/config.js';
import type { ServerCapabilities } from '../src/server/serverCapabilities.js';
import type { ServerFeatureAdapter } from '../src/server/adapters/ServerFeatureAdapter.js';
import type { OpenAIService } from '../src/ai/openai.js';
import type { ContextBuilder } from '../src/ai/contextBuilder.js';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const logger = pino({ level: 'silent' });
const cell = (p: Position) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const world: WorldState = { serverId: 'world-a', connected: true, dimension: 'minecraft:overworld', day: 1, time: 100,
    position: { x: 0.5, y: 64, z: 0.5 }, yaw: -90, health: 20, hunger: 20, armor: 0, inventory: { items: [], freeSlots: 36 },
    equippedItems: [], nearbyPlayers: [], nearbyHostiles: [], nearbyPassiveMobs: [], nearbyUsefulBlocks: [], droppedItems: [],
    environmentalThreats: [], currentAction: 'IDLE', currentGoals: [] };
  const goals: GoalRecord[] = [], terrain = new Map<string, string>(), actions: string[] = [], steps: Position[] = [];
  const clear = (p: Position) => { terrain.set(key(p), 'air'); terrain.set(key({ ...p, y: p.y + 1 }), 'air'); };
  clear(cell(world.position));
  const scan = (radius = 4) => {
    const center = cell(world.position), blocks = [];
    for (let x = -radius; x <= radius; x++) for (let y = -radius; y <= radius; y++) for (let z = -radius; z <= radius; z++) {
      const position = { x: center.x + x, y: center.y + y, z: center.z + z };
      blocks.push({ name: terrain.get(key(position)) ?? 'stone', position });
    }
    return { center, radius, complete: true, blocks };
  };
  const minecraft = {
    serverId: 'world-a', connected: true, supportedActions: ['scan_search_area', 'base_search_step'],
    controlStatus: () => ({ enabled: true }), getWorldState: async () => structuredClone(world),
    scanSearchArea: async () => { actions.push('scan'); return { success: true, action: 'scan_search_area', data: scan() }; },
    baseSearchStep: async (position: Position) => {
      actions.push('step'); steps.push({ ...position }); clear(position);
      world.position = { x: position.x + 0.5, y: position.y, z: position.z + 0.5 };
      return { success: true, action: 'base_search_step' };
    }, cancelCurrentAction: async () => {}
  } as unknown as MinecraftAgent;
  const memory = {
    enabled: true,
    setGoal: (value: Partial<GoalRecord>) => { const goal = { ...value, id: String(goals.length + 1), status: 'active' } as GoalRecord; goals.push(goal); return goal; },
    updateGoal: (id: string, status: GoalRecord['status'], notes: string) => { const goal = goals.find((g) => g.id === id)!; Object.assign(goal, { status, notes }); return goal; },
    getGoals: (_world: string, includeClosed = false) => goals.filter((g) => includeClosed || g.status === 'active'), recordAction: () => {}
  } as unknown as MemoryManager;
  const saved = () => JSON.parse(goals[0]!.notes) as Record<string, any>;
  const runner = new BaseSearchRunner(minecraft, memory);
  const executor = new ToolExecutor(minecraft, memory, new ActionScheduler(minecraft, logger), {} as ServerCapabilities,
    {} as ServerFeatureAdapter, { fabricUnrestricted: true, actionTimeoutMs: 1000 } as AppConfig);
  return { world, goals, terrain, actions, steps, clear, scan, saved, minecraft, memory, runner, executor };
}
const finite = { direction: 'east' as const, branch_length: 2, branch_spacing: 2, max_branches: 2 };

test('base search scans every cell before stepping through non-overlapping parallel branches and reports finite exhaustion honestly', async () => {
  const f = fixture();
  const result = await f.runner.run(finite, new AbortController().signal);
  assert.equal(result.success, true, result.reason); assert.equal(result.data?.outcome, 'area_exhausted'); assert.equal(result.data?.baseConfirmed, false);
  assert.deepEqual(f.steps, [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 2, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }, { x: 1, y: 64, z: 2 }, { x: 0, y: 64, z: 2 }]);
  assert.deepEqual(f.actions, Array.from({ length: 13 }, (_, i) => i % 2 === 0 ? 'scan' : 'step'));
  assert.equal(f.saved().completedSteps, 6); assert.equal(f.goals[0]!.status, 'completed');
  assert.equal(f.runner.status('1').success, true);
});

test('nearby mixed structure evidence pauses before any mining and never marks a base confirmed', async () => {
  const f = fixture(); f.terrain.set('2,64,0', 'chest'); f.terrain.set('2,64,1', 'crafting_table');
  const result = await f.runner.run(finite, new AbortController().signal);
  assert.equal(result.success, true); assert.equal(result.data?.outcome, 'suspected_structure'); assert.equal(result.data?.baseConfirmed, false);
  assert.equal(result.data?.requiresUserConfirmation, true); assert.equal(f.saved().state, 'awaiting_confirmation');
  assert.equal(f.goals[0]!.status, 'active'); assert.deepEqual(f.steps, []);
  await f.runner.resume('1', new AbortController().signal); assert.deepEqual(f.steps, [], 'resume does not override unchanged evidence');
});

test('native construction rejection is recorded as low-confidence suspicion, without a generic mining fallback', async () => {
  const f = fixture();
  f.minecraft.baseSearchStep = async () => ({ success: false, action: 'base_search_step', reason: 'Constructed block nearby', data: { suspectedStructure: true, blockedBlock: { name: 'oak_planks', position: { x: 2, y: 64, z: 0 } } } });
  const result = await f.runner.run(finite, new AbortController().signal);
  assert.equal(result.data?.outcome, 'suspected_structure'); assert.equal(f.saved().completedSteps, 0);
  assert.equal(f.saved().evidence.confidence, 'low'); assert.deepEqual(f.actions, ['scan']);
});

test('incomplete, duplicate, missing or stale scan cells block excavation even if scan success is true', async () => {
  for (const kind of ['incomplete', 'duplicate', 'missing', 'stale', 'outside']) {
    const f = fixture();
    f.minecraft.scanSearchArea = async () => {
      const data = f.scan();
      if (kind === 'incomplete') data.complete = false;
      if (kind === 'duplicate') data.blocks[0] = data.blocks[1]!;
      if (kind === 'missing') data.blocks.pop();
      if (kind === 'stale') data.center.x++;
      if (kind === 'outside') data.blocks[0]!.position.x += 100;
      return { success: true, action: 'scan_search_area', data };
    };
    const result = await f.runner.run(finite, new AbortController().signal);
    assert.equal(result.success, false, kind); assert.deepEqual(f.steps, [], kind); assert.equal(f.saved().completedSteps, 0);
  }
});

test('acknowledgement without arriving never advances saved coverage', async () => {
  const f = fixture(); f.minecraft.baseSearchStep = async () => ({ success: true, action: 'base_search_step' });
  const result = await f.runner.run(finite, new AbortController().signal);
  assert.equal(result.success, false); assert.match(result.reason!, /acknowledgement/); assert.equal(f.saved().completedSteps, 0);
  assert.deepEqual(f.saved().pendingStep, { x: 1, y: 64, z: 0 });
});

test('blocked search resumes only missing steps with a fresh runner, not the already searched prefix', async () => {
  const f = fixture(), original = f.minecraft.baseSearchStep!; let calls = 0;
  f.minecraft.baseSearchStep = async (position) => ++calls === 2 ? { success: false, action: 'base_search_step', reason: 'Tool broke' } : original(position);
  assert.equal((await f.runner.run(finite, new AbortController().signal)).success, false);
  assert.equal(f.saved().completedSteps, 1);
  f.minecraft.baseSearchStep = original;
  const result = await new BaseSearchRunner(f.minecraft, f.memory).resume('1', new AbortController().signal);
  assert.equal(result.success, true, result.reason); assert.equal(f.saved().completedSteps, 6);
  assert.equal(f.steps.filter((p) => key(p) === '1,64,0').length, 1);
});

test('resume refuses wrong world, dimension and position without automatically navigating back', async () => {
  for (const kind of ['world', 'dimension', 'position']) {
    const f = fixture(); f.minecraft.baseSearchStep = async () => ({ success: false, action: 'base_search_step', reason: 'Blocked' });
    await f.runner.run(finite, new AbortController().signal); f.actions.length = 0;
    if (kind === 'world') Object.defineProperty(f.minecraft, 'serverId', { value: 'world-b' });
    if (kind === 'dimension') f.world.dimension = 'minecraft:the_nether';
    if (kind === 'position') f.world.position.x += 10;
    const result = await f.runner.resume('1', new AbortController().signal);
    assert.equal(result.success, false, kind); assert.deepEqual(f.actions, [], kind);
  }
});

test('interrupted arrival reconciles the one saved destination after rescan, not an arbitrary new cell', async () => {
  const f = fixture(), original = f.minecraft.baseSearchStep!, abort = new AbortController();
  f.minecraft.baseSearchStep = async (position) => { const result = await original(position); abort.abort(new Error('Stop')); return result; };
  assert.equal((await f.runner.run(finite, abort.signal)).success, false); assert.equal(f.saved().completedSteps, 0);
  f.minecraft.baseSearchStep = original;
  const resumed = await f.runner.resume('1', new AbortController().signal);
  assert.equal(resumed.success, true, resumed.reason); assert.equal(f.steps.filter((p) => key(p) === '1,64,0').length, 1);
  assert.equal(f.saved().completedSteps, 6);
});

test('late cancelled primitive cannot overwrite a resumed search completed by another runner', async () => {
  const f = fixture(), original = f.minecraft.baseSearchStep!, abort = new AbortController();
  const started = deferred<void>(), pending = deferred<ActionResult>();
  f.minecraft.baseSearchStep = async () => { started.resolve(); return pending.promise; };
  const old = f.runner.run(finite, abort.signal); await started.promise; abort.abort(new Error('Stop'));
  assert.equal(f.saved().state, 'paused');
  f.minecraft.baseSearchStep = original;
  assert.equal((await new BaseSearchRunner(f.minecraft, f.memory).resume('1', new AbortController().signal)).success, true);
  const saved = f.goals[0]!.notes;
  pending.resolve({ success: false, action: 'base_search_step', reason: 'Late cancellation' }); await old;
  assert.equal(f.goals[0]!.notes, saved); assert.equal(f.saved().state, 'exhausted');
});

test('no branch cap by default and abort stops additional steps promptly', async () => {
  const f = fixture(), original = f.minecraft.baseSearchStep!, abort = new AbortController();
  f.minecraft.baseSearchStep = async (position) => { const result = await original(position); if (f.steps.length === 3) abort.abort(new Error('Spoken stop')); return result; };
  const result = await f.runner.run({}, abort.signal);
  assert.equal(result.success, false); assert.equal(f.saved().maxBranches, null); assert.equal(f.saved().state, 'paused');
  assert.equal(f.steps.length, 3); assert.equal(f.saved().pattern.branchLength, 32); assert.equal(f.saved().pattern.direction, 'east');
});

test('wrong start height and disabled memory fail without creating or executing a search', async () => {
  const f = fixture();
  assert.equal((await f.runner.run({ height: -54 }, new AbortController().signal)).success, false);
  assert.equal((await f.runner.run({ origin: { x: 20, y: 64, z: 0 } }, new AbortController().signal)).success, false);
  Object.defineProperty(f.memory, 'enabled', { value: false });
  assert.equal((await f.runner.run({}, new AbortController().signal)).success, false);
  assert.deepEqual(f.goals, []); assert.deepEqual(f.actions, []);
});

test('world boundary yields a saved inspectable blocker with no out-of-range movement', async () => {
  const f = fixture(); f.world.position.x = 29_999_984.5;
  // Valid scan coordinates at the edge of the supported travel range are unavailable;
  // simulate rejection without allowing the reporting path to lose the saved goal ID.
  const result = await f.runner.run({ direction: 'east' }, new AbortController().signal);
  assert.equal(result.success, false); assert.equal(result.data?.goalId, '1'); assert.deepEqual(f.steps, []);
  assert.equal(f.runner.status('1').success, true);
  assert.equal((f.runner.status('1').data?.searches as any[])[0].coverage.nextPosition, null);
});

test('corrupt saved pending target cannot be used to skip unexplored coverage', async () => {
  const f = fixture(); f.minecraft.baseSearchStep = async () => ({ success: false, action: 'base_search_step', reason: 'Blocked' });
  await f.runner.run(finite, new AbortController().signal);
  const saved = f.saved(); saved.pendingStep.x = 99; f.goals[0]!.notes = JSON.stringify(saved); f.actions.length = 0;
  const result = await f.runner.resume('1', new AbortController().signal);
  assert.equal(result.success, false); assert.match(result.reason!, /coverage cursor/); assert.deepEqual(f.actions, []);
});

test('corrupt finite search cannot reconcile an extra pending step beyond requested coverage', async () => {
  const f = fixture(); f.minecraft.baseSearchStep = async () => ({ success: false, action: 'base_search_step', reason: 'Blocked' });
  await f.runner.run({ ...finite, max_branches: 1 }, new AbortController().signal);
  const saved = f.saved(); saved.completedSteps = 2; saved.pendingStep = { x: 2, y: 64, z: 1 }; f.goals[0]!.notes = JSON.stringify(saved);
  assert.equal((await f.runner.resume('1', new AbortController().signal)).success, false);
  assert.equal(f.saved().completedSteps, 2);
});

test('capability gating hides search on old mods and never exposes raw search primitives to the model', async () => {
  const f = fixture();
  assert.ok(f.executor.availableToolNames().includes('search_for_base'));
  assert.ok(!f.executor.availableToolNames().includes('base_search_step')); assert.ok(!f.executor.availableToolNames().includes('scan_search_area'));
  assert.equal((await f.executor.execute('base_search_step', '{}')).success, false);
  assert.equal((await f.executor.execute('search_for_base', JSON.stringify({ branch_spacing: 0 }))).success, false);
  assert.deepEqual(f.actions, []);
  Object.defineProperty(f.minecraft, 'supportedActions', { value: ['mine_block', 'move_to'] });
  assert.ok(!f.executor.availableToolNames().includes('search_for_base'));
  assert.equal((await f.executor.execute('search_for_base', '{}')).success, false);
});

test('search tool schema is strict and all defaultable API fields are explicitly nullable', () => {
  const tool = minecraftTools.find((t) => t.name === 'search_for_base')!;
  const schema = tool.parameters as any;
  assert.equal(tool.strict, true); assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort());
  assert.equal(schema.properties.origin.anyOf[0].additionalProperties, false);
});

test('until-stop planner ends with a report after search returns and suppresses a same-batch fallback mining call', async () => {
  const f = fixture(), requests: ResponseCreateParamsNonStreaming[] = [], executed: string[] = [];
  const executor = { availableToolNames: () => ['search_for_base', 'mine_block'], isClientControl: () => true,
    execute: async (name: string) => { executed.push(name); return { success: true, action: name, data: { outcome: 'suspected_structure', baseConfirmed: false } }; }
  } as unknown as ToolExecutor;
  const api = { requireClient: () => ({ responses: { create: async (request: ResponseCreateParamsNonStreaming) => {
    requests.push(request);
    return { id: String(requests.length), status: 'completed', error: null, incomplete_details: null,
      output_text: requests.length === 1 ? '' : 'Possible structure nearby. I stopped; should we investigate?',
      output: requests.length === 1 ? [
        { type: 'function_call', name: 'search_for_base', call_id: 'search', arguments: '{}' },
        { type: 'function_call', name: 'mine_block', call_id: 'unsafe-followup', arguments: '{}' }
      ] : [] } as Response;
  } } }) } as unknown as OpenAIService;
  const context = { build: async () => ({ worldState: f.world }) } as unknown as ContextBuilder;
  const planner = new Planner(api, context, executor, logger, 'Astra', 'Owner', 'test-model', 6, true);
  try {
    const result = await planner.think({ type: 'PLAYER_SPOKE', serverId: 'world-a', timestamp: new Date().toISOString(), summary: 'Search until I say stop',
      data: { username: 'Owner', channel: 'voice', message: 'Search for a base until I say stop' } });
    assert.deepEqual(executed, ['search_for_base']); assert.equal(requests.length, 2); assert.equal(requests[1]!.tool_choice, 'none');
    assert.match(requests[0]!.instructions!, /suspected structure|Suspected structure/); assert.match(result.text, /Possible/);
  } finally { planner.close(); }
});

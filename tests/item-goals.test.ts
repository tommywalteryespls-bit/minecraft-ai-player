import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { ItemGoalRunner, inventoryCounts } from '../src/skills/itemGoals.js';
import { RecipeCatalog, armorDestination, armorSets, smeltingSources } from '../src/skills/recipeCatalog.js';
import { FabricSkills } from '../src/minecraft/adapters/fabric/FabricSkills.js';
import { ToolExecutor } from '../src/ai/toolExecutor.js';
import { ActionScheduler } from '../src/core/actionScheduler.js';
import { playerControlPrompt } from '../src/ai/prompts.js';
import { minecraftTools, toolForController } from '../src/ai/tools.js';
import type { AppConfig } from '../src/config.js';
import type { MinecraftAgent } from '../src/minecraft/MinecraftAgent.js';
import type { ActionResult, WorldState } from '../src/minecraft/types.js';
import type { MemoryManager } from '../src/memory/memoryManager.js';
import type { GoalRecord } from '../src/memory/types.js';
import type { ServerCapabilities } from '../src/server/serverCapabilities.js';
import type { ServerFeatureAdapter } from '../src/server/adapters/ServerFeatureAdapter.js';

const catalog = new RecipeCatalog();
function fixture(initial: Record<string, number> = {}) {
  const stock = { ...initial }, stations = new Set<string>(), calls: string[] = [], goals: GoalRecord[] = [];
  const world: WorldState = { serverId: 'world-a', connected: true, dimension: 'minecraft:overworld', day: 1, time: 100,
    position: { x: 0, y: 64, z: 0 }, health: 20, hunger: 20, armor: 0, inventory: { items: [], freeSlots: 36 },
    equippedItems: [], nearbyPlayers: [], nearbyHostiles: [], nearbyPassiveMobs: [], nearbyUsefulBlocks: [], droppedItems: [],
    environmentalThreats: [], currentAction: 'IDLE', currentGoals: [] };
  const refresh = () => { world.inventory.items = Object.entries(stock).filter(([, count]) => count > 0).map(([name, count], slot) => ({ name, displayName: name, count, slot })); return structuredClone(world); };
  const take = (item: string, count: number) => { assert.ok((stock[item] ?? 0) >= count, `missing ${count} ${item}`); stock[item]! -= count; };
  const record = (name: string): ActionResult => { calls.push(name); assert.ok(calls.length < 300, 'prerequisites must not cycle'); return { success: true, action: name }; };
  const station = (name: string) => { if (!stations.has(name)) { take(name, 1); stations.add(name); } };
  const minecraft = {
    serverId: 'world-a', connected: true,
    supportedActions: ['collect_resource', 'craft_item', 'smelt_item', 'equip_item', 'move_to', 'find_block'],
    controlStatus: () => ({ enabled: true }),
    getWorldState: async () => refresh(),
    findBlock: async (block: string) => ({ success: stations.has(block), action: 'find_block', data: stations.has(block) ? { position: world.position } : undefined }),
    moveNear: async () => record('move_near'),
    collectResource: async (item: string, count: number) => {
      const source = catalog.sources(item)[0]; assert.ok(source, `block source for ${item}`);
      const tool = catalog.toolFor(source, stock); if (tool) assert.ok((stock[tool] ?? 0) > 0, `harvest tool for ${item}: ${tool}`);
      stock[item] = (stock[item] ?? 0) + count; return record(`collect:${item}:${count}`);
    },
    craftItem: async (item: string, amount: number) => {
      const recipe = catalog.recipes(item).find((r) => Object.entries(r.ingredients).every(([n, count]) => (stock[n] ?? 0) >= count * Math.ceil(amount / r.count)));
      assert.ok(recipe, `actual recipe and ingredients for ${item}`);
      if (recipe.table) station('crafting_table');
      const repeats = Math.ceil(amount / recipe.count);
      for (const [name, count] of Object.entries(recipe.ingredients)) take(name, count * repeats);
      stock[item] = (stock[item] ?? 0) + repeats * recipe.count; return record(`craft:${item}:${amount}`);
    },
    smeltItem: async ({ input, fuel, amount }: { input: string; fuel: string; amount: number }) => {
      assert.ok(amount <= 64); station('furnace'); take(input, amount); take(fuel, Math.ceil(amount / 8));
      const output = Object.entries(smeltingSources).find(([, value]) => value === input)![0];
      stock[output] = (stock[output] ?? 0) + amount; return record(`smelt:${input}:${amount}`);
    },
    equipItem: async (item: string, destination: string) => {
      const slots: Record<string, number> = { head: 5, torso: 4, legs: 3, feet: 2 };
      if (slots[destination]) {
        if (world.equippedItems.some((i) => i.name === item && i.slot === slots[destination])) return record(`equip:${item}`);
        take(item, 1); world.equippedItems = world.equippedItems.filter((i) => i.slot !== slots[destination]);
        world.equippedItems.push({ name: item, displayName: item, count: 1, slot: slots[destination]! });
      }
      return record(`equip:${item}`);
    },
    cancelCurrentAction: async () => {},
  } as unknown as MinecraftAgent;
  const memory = {
    setGoal: (value: Partial<GoalRecord>) => { const goal = { ...value, id: String(goals.length + 1), status: 'active' } as GoalRecord; goals.push(goal); return goal; },
    updateGoal: (id: string, status: GoalRecord['status'], notes: string) => { const goal = goals.find((g) => g.id === id)!; Object.assign(goal, { status, notes }); return goal; },
    getGoals: () => goals.filter((g) => g.status === 'active'), recordAction: () => {}
  } as unknown as MemoryManager;
  return { stock, stations, calls, goals, world, minecraft, memory, refresh, runner: new ItemGoalRunner(minecraft, memory, catalog) };
}

test('vanilla recipe catalog knows diamond armor costs, yields, tools and acyclic alternatives', () => {
  assert.equal(armorSets.diamond_armor!.reduce((n, item) => n + catalog.recipes(item)[0]!.ingredients.diamond!, 0), 24);
  assert.equal(catalog.recipes('stick')[0]!.count, 4);
  assert.ok(catalog.sources('diamond').includes('diamond_ore'));
  assert.equal(catalog.toolFor('diamond_ore', {}), 'iron_pickaxe');
  assert.equal(catalog.choose('stick', { spruce_log: 1 })?.ingredients.spruce_planks, 2);
  assert.equal(catalog.choose('stick', {}, [], ['birch_log'])?.ingredients.birch_planks, 2);
  assert.equal(catalog.choose('oak_planks', {}, ['oak_log']), undefined);
  assert.deepEqual(catalog.recipes('not_an_item'), []);
});

test('inventory totals include worn armor but never double-count a helmet held in the main hand', () => {
  const f = fixture({ diamond_helmet: 1 }); const world = f.refresh();
  world.equippedItems = [{ name: 'diamond_helmet', displayName: '', count: 1, slot: 0 }, { name: 'diamond_helmet', displayName: '', count: 1, slot: 5 }];
  assert.equal(inventoryCounts(world).diamond_helmet, 2);
});

test('diamond armor goal resolves wood, tools, furnace, iron, 24 diamonds, crafting and all equipment from empty inventory', async () => {
  const f = fixture();
  const result = await f.runner.run({ item: 'diamond_armor', amount: 1, equip: true }, new AbortController().signal);
  assert.equal(result.success, true, result.reason);
  assert.equal(result.data?.verified, true); assert.equal(f.goals[0]?.status, 'completed');
  assert.equal(f.world.equippedItems.length, 4);
  const collected = f.calls.filter((c) => c.startsWith('collect:diamond:')).reduce((n, c) => n + Number(c.split(':')[2]), 0);
  assert.equal(collected, 24);
  for (const item of ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'furnace', 'crafting_table']) assert.ok(f.calls.some((call) => call.startsWith(`craft:${item}:`)), item);
  assert.ok(f.calls.some((call) => call.startsWith('smelt:raw_iron:')));
});

test('already satisfied goal does not mine or craft extra resources', async () => {
  const f = fixture({ diamond: 24 });
  const result = await f.runner.run({ item: 'diamond', amount: 24, equip: false }, new AbortController().signal);
  assert.equal(result.success, true); assert.deepEqual(f.calls, []);
});

test('partially equipped armor goal reuses existing pieces and diamonds', async () => {
  const f = fixture({ diamond: 19, crafting_table: 1 });
  f.world.equippedItems.push({ name: 'diamond_helmet', displayName: '', count: 1, slot: 5 });
  const result = await f.runner.run({ item: 'diamond_armor', amount: 1, equip: true }, new AbortController().signal);
  assert.equal(result.success, true, result.reason);
  assert.ok(!f.calls.some((call) => call.startsWith('collect:') || call.startsWith('craft:diamond_helmet:')));
});

test('crafting respects recipe yield without repeatedly gathering leftover sticks', async () => {
  const f = fixture({ oak_planks: 2 });
  assert.equal((await f.runner.run({ item: 'stick', amount: 3, equip: false }, new AbortController().signal)).success, true);
  assert.equal(f.stock.stick, 4); assert.deepEqual(f.calls, ['craft:stick:3']);
});

test('large smelting goals split into real furnace batches', async () => {
  const f = fixture({ raw_iron: 70, coal: 9, furnace: 1 });
  const result = await f.runner.run({ item: 'iron_ingot', amount: 70, equip: false }, new AbortController().signal);
  assert.equal(result.success, true, result.reason); assert.equal(f.stock.iron_ingot, 70);
  assert.deepEqual(f.calls, ['smelt:raw_iron:64', 'smelt:raw_iron:6']);
});

test('blocked item goal persists and explicitly resumes missing work in the same world', async () => {
  const f = fixture({ iron_pickaxe: 1 }); const original = f.minecraft.collectResource;
  f.minecraft.collectResource = async () => ({ success: false, action: 'collect_resource', reason: 'Protected region' });
  const first = await f.runner.run({ item: 'diamond', amount: 3, equip: false }, new AbortController().signal);
  assert.equal(first.success, false); assert.equal(first.data?.state, 'blocked'); assert.equal(f.goals[0]!.status, 'active');
  f.minecraft.collectResource = original; f.stock.diamond = 2;
  const second = await f.runner.resume(String(first.data?.goalId), new AbortController().signal);
  assert.equal(second.success, true, second.reason); assert.ok(f.calls.includes('collect:diamond:1')); assert.equal(f.goals.length, 1);
});

test('resume refuses a goal belonging to a different world', async () => {
  const f = fixture();
  f.goals.push({ id: 'other', serverId: 'world-b', status: 'active', notes: '{}' } as GoalRecord);
  const result = await f.runner.resume('other', new AbortController().signal);
  assert.equal(result.success, false); assert.deepEqual(f.calls, []);
});

test('an acknowledgement without inventory progress cannot complete an item goal', async () => {
  const f = fixture({ iron_pickaxe: 1 });
  f.minecraft.collectResource = async () => ({ success: true, action: 'collect_resource' });
  const result = await f.runner.run({ item: 'diamond', amount: 1, equip: false }, new AbortController().signal);
  assert.equal(result.success, false); assert.match(result.reason!, /Inventory verification/); assert.equal(f.goals[0]!.status, 'active');
});

test('cancellation after a primitive pauses the goal and prevents further crafting', async () => {
  const f = fixture({ iron_pickaxe: 1 }), controller = new AbortController();
  f.minecraft.collectResource = async () => { controller.abort(new Error('Spoken stop')); return { success: true, action: 'collect_resource' }; };
  const result = await f.runner.run({ item: 'diamond_armor', amount: 1, equip: true }, controller.signal);
  assert.equal(result.success, false); assert.equal(result.data?.state, 'paused'); assert.ok(!f.calls.some((call) => call.startsWith('craft:')));
});

test('unknown items and unsupported hunting goals fail honestly without Minecraft actions', async () => {
  const f = fixture();
  assert.equal((await f.runner.run({ item: 'made_up', amount: 1, equip: false }, new AbortController().signal)).success, false);
  const result = await f.runner.run({ item: 'beef', amount: 1, equip: false }, new AbortController().signal);
  assert.equal(result.success, false); assert.match(result.reason!, /No implemented/); assert.deepEqual(f.calls, []);
});

test('Fabric crafting sends the actual vanilla grid instead of model-generated ingredients', async () => {
  const f = fixture({ diamond: 8 }), calls: Record<string, unknown>[] = [];
  const skills = new FabricSkills(async (action, args) => { calls.push(args); return { success: true, action }; }, () => f.minecraft.getWorldState());
  assert.equal((await skills.craft('diamond_chestplate', 1, new AbortController().signal)).success, true);
  assert.equal(calls[0]?.table, true); assert.deepEqual(calls[0]?.grid, catalog.recipes('diamond_chestplate')[0]!.grid);
  assert.equal((await skills.craft('diamond_chestplate', 2, new AbortController().signal)).success, false);
  assert.equal(calls.length, 1);
});

test('buried nearby mining target triggers approach after a visibility failure, then retries', async () => {
  const f = fixture(), names: string[] = [];
  const skills = new FabricSkills(async (action, args) => {
    names.push(action);
    if (names.length === 1) return { success: false, action, reason: 'Block must be visible within normal reach' };
    if (action === 'move_near') { assert.equal(args.can_dig, true); assert.equal(args.radius, 1.5); }
    return { success: true, action };
  }, () => f.minecraft.getWorldState());
  const result = await skills.mine({ position: { x: 2, y: 64, z: 0 } }, new AbortController().signal);
  assert.equal(result.success, true); assert.deepEqual(names, ['mine_block', 'move_near', 'mine_block']);
});

test('goal tools are capability gated and updated prompts do not claim crafting is unsupported', async () => {
  const f = fixture(), logger = pino({ level: 'silent' });
  const executor = new ToolExecutor(f.minecraft, f.memory, new ActionScheduler(f.minecraft, logger), {} as ServerCapabilities, {} as ServerFeatureAdapter, { fabricUnrestricted: true } as AppConfig);
  assert.ok(executor.availableToolNames().includes('acquire_item'));
  assert.equal((await executor.execute('acquire_item', JSON.stringify({ item: 'diamond', amount: 1, equip: false }))).success, true);
  const prompt = playerControlPrompt('Astra', true, true);
  assert.match(prompt, /acquire_item/); assert.doesNotMatch(prompt, /crafting.*not implemented|not pathfinding/);
  const tool = toolForController(minecraftTools.find((tool) => tool.name === 'equip_item')!, true, true, true);
  assert.match(tool.description!, /armor/); assert.doesNotMatch(tool.description!, /unsupported/);
  Object.defineProperty(f.minecraft, 'supportedActions', { value: ['control_player'] });
  assert.ok(!executor.availableToolNames().includes('acquire_item'));
});

test('scheduler cancellation reaches a long-running item goal without dispatching the next prerequisite', async () => {
  const f = fixture({ iron_pickaxe: 1 }), logger = pino({ level: 'silent' });
  let finish!: (value: ActionResult) => void, started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  f.minecraft.collectResource = async () => { started(); return new Promise<ActionResult>((resolve) => { finish = resolve; }); };
  f.minecraft.cancelCurrentAction = async () => { finish({ success: false, action: 'collect_resource', reason: 'Cancelled' }); };
  const scheduler = new ActionScheduler(f.minecraft, logger);
  const executor = new ToolExecutor(f.minecraft, f.memory, scheduler, {} as ServerCapabilities, {} as ServerFeatureAdapter, { fabricUnrestricted: true } as AppConfig);
  const pending = executor.execute('acquire_item', JSON.stringify({ item: 'diamond_armor', amount: 1, equip: true }));
  await ready; await scheduler.stop();
  assert.equal((await pending).success, false);
  assert.equal(JSON.parse(f.goals[0]!.notes).state, 'paused'); assert.ok(!f.calls.some((call) => call.startsWith('craft:')));
});

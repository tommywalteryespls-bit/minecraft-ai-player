import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { ActionScheduler } from '../core/actionScheduler.js';
import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import type { ActionResult, ActionState, Position } from '../minecraft/types.js';
import type { MemoryManager } from '../memory/memoryManager.js';
import type { ServerFeatureAdapter } from '../server/adapters/ServerFeatureAdapter.js';
import type { ServerCapabilities } from '../server/serverCapabilities.js';
import { safeJson } from '../utils/errors.js';
import { ItemGoalRunner } from '../skills/itemGoals.js';
import { RecipeCatalog, armorSets, smeltingSources } from '../skills/recipeCatalog.js';
import { BaseSearchRunner, BaseSearchRequestSchema } from '../skills/baseSearch.js';

const position = z.object({ x: z.number(), y: z.number(), z: z.number() });
const nullablePosition = position.nullable().optional();
const empty = z.object({}).strict();

const schemas = {
  search_for_base: BaseSearchRequestSchema,
  resume_base_search: z.object({ id: z.string().min(1) }).strict(),
  inspect_base_search: z.object({ id: z.string().min(1).nullish() }).strict(),
  acquire_item: z.object({ item: z.string().min(1), amount: z.number().int().min(1).max(2304), equip: z.boolean() }).strict(),
  resume_item_goal: z.object({ id: z.string().min(1) }).strict(),
  inspect_recipes: z.object({ item: z.string().min(1) }).strict(),
  control_player: z.object({
    command: z.enum(['walk', 'turn', 'jump', 'use', 'attack', 'mine_target', 'stop']),
    direction: z.enum(['forward', 'backward', 'left', 'right']).nullish(),
    duration_ms: z.number().int().min(100).max(10000).nullish(),
    yaw: z.number().min(-180).max(180).nullish(),
    pitch: z.number().min(-90).max(90).nullish()
  }).strict(),
  inspect_surroundings: empty,
  inspect_inventory: empty,
  look_at: z.object({ target: position }),
  move_to: z.object({ position, timeout_ms: z.number().int().nullable() }),
  move_near: z.object({ position, radius: z.number().min(0), timeout_ms: z.number().int().nullable() }),
  follow_player: z.object({ username: z.string().min(1) }),
  stop_following: empty,
  find_block: z.object({ block: z.string(), radius: z.number().int().nullable() }),
  mine_block: z.object({ block: z.string().nullable(), position: nullablePosition }),
  collect_resource: z.object({ resource: z.string(), amount: z.number().int().min(1).max(64) }),
  pickup_items: z.object({ radius: z.number().int().nullable() }),
  craft_item: z.object({ item: z.string(), amount: z.number().int().min(1).max(64) }),
  eat_best_food: empty,
  equip_item: z.object({ item: z.string(), destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']).nullable() }),
  attack_entity: z.object({ entity_id: z.string() }),
  attack_nearest_hostile: empty,
  flee: z.object({ threat_id: z.string() }),
  place_block: z.object({ item: z.string(), position, against: nullablePosition }),
  sleep: empty,
  inspect_container: z.object({ position }),
  deposit_item: z.object({ position, item: z.string(), amount: z.number().int().min(1).max(64) }),
  withdraw_item: z.object({ position, item: z.string(), amount: z.number().int().min(1).max(64) }),
  smelt_item: z.object({ input: z.string(), fuel: z.string().nullable(), amount: z.number().int(), furnace_position: nullablePosition }),
  say: z.object({ message: z.string().min(1).max(240) }),
  remember_location: z.object({ name: z.string(), description: z.string(), importance: z.number().min(0).max(1) }),
  recall_location: z.object({ name: z.string() }),
  set_goal: z.object({ description: z.string(), priority: z.number().int(), scope: z.enum(['global', 'server']), notes: z.string() }),
  complete_goal: z.object({ id: z.string(), notes: z.string() }),
  list_goals: empty,
  remember_lesson: z.object({ content: z.string(), scope: z.enum(['global', 'server']), importance: z.number().min(0).max(1) }),
  inspect_server_capabilities: empty,
  server_action: z.object({ action: z.string(), arguments: z.record(z.string(), z.unknown()) })
} satisfies Record<string, z.ZodType>;

type ToolName = keyof typeof schemas;

const unrestrictedControl = schemas.control_player.extend({
  duration_ms: z.number().int().min(0).max(2_147_483_647).nullish()
}).refine((args) => args.duration_ms !== 0 || args.command === 'walk', 'Zero duration is only valid for continuing walks');

const stateByTool: Partial<Record<ToolName, ActionState>> = {
  search_for_base: 'MINING', resume_base_search: 'MINING',
  acquire_item: 'CRAFTING', resume_item_goal: 'CRAFTING',
  control_player: 'INTERACTING',
  move_to: 'MOVING', move_near: 'MOVING', follow_player: 'FOLLOWING', stop_following: 'IDLE',
  mine_block: 'MINING', collect_resource: 'MINING', pickup_items: 'MOVING', craft_item: 'CRAFTING',
  eat_best_food: 'EATING', equip_item: 'INTERACTING', attack_entity: 'COMBAT', attack_nearest_hostile: 'COMBAT',
  flee: 'FLEEING', place_block: 'BUILDING', sleep: 'SLEEPING', inspect_container: 'INTERACTING',
  deposit_item: 'INTERACTING', withdraw_item: 'INTERACTING', smelt_item: 'INTERACTING', server_action: 'INTERACTING'
};

export class ToolExecutor {
  private itemGoals?: ItemGoalRunner;
  private baseSearch?: BaseSearchRunner;
  constructor(
    private readonly minecraft: MinecraftAgent,
    private readonly memory: MemoryManager,
    private readonly scheduler: ActionScheduler,
    private readonly capabilities: ServerCapabilities,
    private readonly serverFeatures: ServerFeatureAdapter,
    private readonly config: AppConfig
  ) {}

  availableToolNames(): readonly string[] {
    const supported = this.minecraft.supportedActions;
    // The prerequisite runner currently uses the Fabric 1.21.11 recipe/controller contract.
    if (!supported) return Object.keys(schemas).filter((name) => !['control_player', 'acquire_item', 'resume_item_goal', 'inspect_recipes', 'search_for_base', 'resume_base_search', 'inspect_base_search'].includes(name));
    const goals = ['collect_resource', 'craft_item', 'smelt_item', 'equip_item'].every((name) => supported.includes(name))
      ? ['acquire_item', 'resume_item_goal', 'inspect_recipes'] : [];
    const search = this.minecraft.scanSearchArea && this.minecraft.baseSearchStep && ['scan_search_area', 'base_search_step'].every((name) => supported.includes(name))
      ? ['search_for_base', 'resume_base_search', 'inspect_base_search'] : [];
    return [...search, ...goals, ...supported.filter((name) => name in schemas), 'inspect_surroundings', 'inspect_inventory',
      'remember_location', 'recall_location', 'list_goals', 'remember_lesson', 'inspect_server_capabilities'];
  }

  isClientControl(): boolean { return typeof this.minecraft.controlStatus === 'function'; }
  isUnrestrictedControl(): boolean { return this.isClientControl() && this.config.fabricUnrestricted === true; }

  async execute(name: string, rawArguments: string, signal?: AbortSignal): Promise<ActionResult> {
    if (signal?.aborted) return { success: false, action: name, reason: 'Request cancelled before action started' };
    if (!(name in schemas)) return { success: false, action: name, reason: 'Tool is not allowlisted' };
    if (!this.availableToolNames().includes(name)) return { success: false, action: name, reason: 'This controller does not implement that action' };
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawArguments) as unknown;
    } catch {
      return { success: false, action: name, reason: 'Malformed JSON tool arguments' };
    }
    const toolName = name as ToolName;
    const validated = (toolName === 'control_player' && this.isUnrestrictedControl() ? unrestrictedControl : schemas[toolName]).safeParse(parsedJson);
    if (!validated.success) {
      return { success: false, action: name, reason: `Invalid tool arguments: ${z.prettifyError(validated.error)}` };
    }
    const args = validated.data as Record<string, unknown>;
    if (toolName === 'control_player' && args.command === 'stop') {
      await this.scheduler.stop();
      await this.minecraft.cancelCurrentAction('Player requested stop');
      return this.minecraft.controlPlayer ? this.minecraft.controlPlayer({ command: 'stop' }) : { success: false, action: name, reason: 'Fabric client is not selected' };
    }
    const startedAt = new Date().toISOString();
    // A player may cancel while a higher-priority reflex keeps this action queued.
    const operation = (schedulerSignal?: AbortSignal) => {
      const combined = AbortSignal.any([signal, schedulerSignal].filter((s): s is AbortSignal => Boolean(s)));
      return combined.aborted
        ? Promise.resolve({ success: false, action: name, reason: 'Request cancelled before action started' })
        : this.dispatch(toolName, args, combined);
    };
    const result = stateByTool[toolName]
      ? await this.scheduler.schedule(name, stateByTool[toolName] ?? 'INTERACTING', toolName === 'flee' ? 90 : 20,
        this.isUnrestrictedControl() ? 0 : this.config.actionTimeoutMs * (toolName === 'collect_resource' ? 4 : 1), operation, signal)
      : await operation();
    const clean = safeJson(result) as ActionResult;
    this.memory.recordAction({ serverId: this.minecraft.serverId, action: name, arguments: args, result: clean, startedAt });
    return clean;
  }

  private async dispatch(name: ToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<ActionResult> {
    const pos = (key: string) => args[key] as Position;
    switch (name) {
      case 'search_for_base': return (this.baseSearch ??= new BaseSearchRunner(this.minecraft, this.memory)).run(args, signal);
      case 'resume_base_search': return (this.baseSearch ??= new BaseSearchRunner(this.minecraft, this.memory)).resume(args.id as string, signal);
      case 'inspect_base_search': return (this.baseSearch ??= new BaseSearchRunner(this.minecraft, this.memory)).status(args.id as string | null | undefined);
      case 'acquire_item': return (this.itemGoals ??= new ItemGoalRunner(this.minecraft, this.memory))
        .run({ item: args.item as string, amount: args.amount as number, equip: args.equip as boolean }, signal);
      case 'resume_item_goal': return (this.itemGoals ??= new ItemGoalRunner(this.minecraft, this.memory)).resume(args.id as string, signal);
      case 'inspect_recipes': {
        const item = args.item as string, catalog = new RecipeCatalog();
        return { success: catalog.known(item) || Boolean(armorSets[item]), action: name,
          data: { item, armorSet: armorSets[item] ?? null, recipes: catalog.recipes(item), blockSources: catalog.sources(item), smeltingInput: smeltingSources[item] ?? null } };
      }
      case 'control_player': return this.minecraft.controlPlayer
        ? this.minecraft.controlPlayer({ command: args.command as import('../minecraft/types.js').PlayerControlRequest['command'],
          direction: args.direction as import('../minecraft/types.js').PlayerControlRequest['direction'] ?? undefined,
          duration_ms: args.duration_ms as number ?? undefined, yaw: args.yaw as number ?? undefined, pitch: args.pitch as number ?? undefined })
        : Promise.resolve({ success: false, action: name, reason: 'This command requires the Fabric client mod' });
      case 'inspect_surroundings': return { success: true, action: name, data: safeJson(await this.minecraft.getWorldState()) as Record<string, unknown> };
      case 'inspect_inventory': return { success: true, action: name, data: safeJson(await this.minecraft.getInventory()) as Record<string, unknown> };
      case 'look_at': return this.minecraft.lookAt(pos('target'));
      case 'move_to': return this.minecraft.moveTo(pos('position'), { timeoutMs: (args.timeout_ms as number | null) ?? undefined });
      case 'move_near': return this.minecraft.moveNear(pos('position'), args.radius as number, { timeoutMs: (args.timeout_ms as number | null) ?? undefined });
      case 'follow_player': return this.minecraft.followPlayer(args.username as string);
      case 'stop_following': return this.minecraft.stopFollowing();
      case 'find_block': return this.minecraft.findBlock(args.block as string, (args.radius as number | null) ?? undefined);
      case 'mine_block': return this.minecraft.mineBlock({ block: (args.block as string | null) ?? undefined, position: (args.position as Position | null) ?? undefined });
      case 'collect_resource': return this.minecraft.collectResource(args.resource as string, args.amount as number);
      case 'pickup_items': return this.minecraft.pickupItems((args.radius as number | null) ?? undefined);
      case 'craft_item': return this.minecraft.craftItem(args.item as string, args.amount as number);
      case 'eat_best_food': return this.minecraft.eatBestFood();
      case 'equip_item': return this.minecraft.equipItem(args.item as string, (args.destination as Parameters<MinecraftAgent['equipItem']>[1] | null) ?? undefined);
      case 'attack_entity': return this.minecraft.attackEntity(args.entity_id as string);
      case 'attack_nearest_hostile': return this.minecraft.attackNearestHostile();
      case 'flee': return this.minecraft.fleeFrom(args.threat_id as string);
      case 'place_block': return this.minecraft.placeBlock({ item: args.item as string, position: pos('position'), against: (args.against as Position | null) ?? undefined });
      case 'sleep': return this.minecraft.sleep();
      case 'inspect_container': return this.minecraft.inspectContainer({ position: pos('position') });
      case 'deposit_item': return this.minecraft.depositItem({ position: pos('position'), item: args.item as string, amount: args.amount as number });
      case 'withdraw_item': return this.minecraft.withdrawItem({ position: pos('position'), item: args.item as string, amount: args.amount as number });
      case 'smelt_item': return this.minecraft.smeltItem({ input: args.input as string, fuel: (args.fuel as string | null) ?? undefined, amount: args.amount as number, furnacePosition: (args.furnace_position as Position | null) ?? undefined });
      case 'say': return this.minecraft.sayText(args.message as string);
      case 'remember_location': {
        const state = await this.minecraft.getWorldState();
        const location = this.memory.rememberLocation({ serverId: state.serverId, dimension: state.dimension, name: args.name as string, position: state.position, description: args.description as string, importance: args.importance as number });
        return { success: true, action: name, data: safeJson(location) as Record<string, unknown> };
      }
      case 'recall_location': {
        const state = await this.minecraft.getWorldState();
        const location = this.memory.recallLocation(state.serverId, state.dimension, args.name as string);
        return location ? { success: true, action: name, data: safeJson(location) as Record<string, unknown> } : { success: false, action: name, reason: 'Location is not known in this server and dimension' };
      }
      case 'set_goal': {
        const scope = args.scope as 'global' | 'server';
        const goal = this.memory.setGoal({ description: args.description as string, priority: args.priority as number, scope, serverId: scope === 'server' ? this.minecraft.serverId : undefined, notes: args.notes as string });
        return { success: true, action: name, data: safeJson(goal) as Record<string, unknown> };
      }
      case 'complete_goal': {
        const goal = this.memory.updateGoal(args.id as string, 'completed', args.notes as string);
        return goal ? { success: true, action: name, data: safeJson(goal) as Record<string, unknown> } : { success: false, action: name, reason: 'Goal was not found' };
      }
      case 'list_goals': return { success: true, action: name, data: { goals: safeJson(this.memory.getGoals(this.minecraft.serverId)) } };
      case 'remember_lesson': {
        const scope = args.scope as 'global' | 'server';
        const id = this.memory.addMemory({ scope, serverId: scope === 'server' ? this.minecraft.serverId : undefined, category: 'lesson', content: args.content as string, importance: args.importance as number });
        return { success: true, action: name, data: { id } };
      }
      case 'inspect_server_capabilities': return { success: true, action: name, data: safeJson(this.capabilities) as Record<string, unknown> };
      case 'server_action': return this.serverFeatures.execute(args.action as string, args.arguments as Record<string, unknown>);
    }
  }
}

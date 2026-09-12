import { setTimeout as delay } from 'node:timers/promises';
import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import type { ActionResult, WorldState } from '../minecraft/types.js';
import type { MemoryManager } from '../memory/memoryManager.js';
import { armorDestination, armorSets, RecipeCatalog, smeltingSources } from './recipeCatalog.js';

export interface ItemGoalSpec { item: string; amount: number; equip: boolean }
interface SavedGoal { kind: 'item-acquisition-v1'; spec: ItemGoalSpec; state: 'running' | 'paused' | 'blocked' | 'completed'; step?: string }

export function inventoryCounts(world: WorldState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of world.inventory.items) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  // Fabric uses EquipmentSlot ordinals: hands 0/1, worn armor 2..5. A helmet held in the hand is not worn armor.
  for (const item of world.equippedItems) if (item.slot >= 2 && item.slot <= 5 && armorDestination(item.name)) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}

/** Mindcraft-inspired prerequisite resolution; outcomes come from live inventory, not action acknowledgements. */
export class ItemGoalRunner {
  constructor(private readonly minecraft: MinecraftAgent, private readonly memory: MemoryManager,
    private readonly catalog = new RecipeCatalog()) {}

  async run(spec: ItemGoalSpec, signal: AbortSignal, existingId?: string): Promise<ActionResult> {
    const worldId = this.minecraft.serverId;
    const targets = armorSets[spec.item] ?? [spec.item];
    if (!Number.isInteger(spec.amount) || spec.amount < 1 || spec.amount > 2304 || targets.some((name) => !this.catalog.known(name))) {
      return { success: false, action: 'acquire_item', reason: 'Unknown vanilla item/armor set or invalid amount' };
    }
    if (armorSets[spec.item] && spec.amount !== 1) return { success: false, action: 'acquire_item', reason: 'Request one armor set at a time' };
    const saved: SavedGoal = { kind: 'item-acquisition-v1', spec, state: 'running' };
    const goalId = existingId ?? this.memory.setGoal({ description: `Acquire ${spec.amount} ${spec.item}${spec.equip ? ' and equip it' : ''}`,
      priority: 80, scope: 'server', serverId: worldId, notes: JSON.stringify(saved) }).id;
    // Scheduler interruption can return before a primitive settles. Persist pause immediately,
    // not only when the eventual action result unwinds the prerequisite stack.
    const paused = () => { saved.state = 'paused'; saved.step = 'User/task cancellation'; this.memory.updateGoal(goalId, 'active', JSON.stringify(saved)); };
    signal.addEventListener('abort', paused, { once: true });
    const check = () => { signal.throwIfAborted(); if (!this.minecraft.connected || this.minecraft.serverId !== worldId) throw new Error('World connection changed'); };
    const progress = (step: string) => { check(); saved.step = step; this.memory.updateGoal(goalId, 'active', JSON.stringify(saved)); };
    const requireAction = async (operation: Promise<ActionResult>) => {
      const result = await operation; check();
      if (!result.success) throw new Error(`${result.action}: ${result.reason ?? 'action did not complete'}`);
      return result;
    };
    const counts = async () => { check(); return inventoryCounts(await this.minecraft.getWorldState()); };
    const station = async (name: string, ancestors: string[]) => {
      const found = await this.minecraft.findBlock(name, 16); check();
      if (found.success && found.data?.position) {
        await requireAction(this.minecraft.moveNear(found.data.position as { x: number; y: number; z: number }, 3, { canDig: false }));
        return;
      }
      await ensure(name, 1, ancestors);
      // Fabric crafting/smelting places an owned station in reachable free space if none is present.
    };
    const ensure = async (item: string, target: number, ancestors: string[]): Promise<void> => {
      check();
      let inventory = await counts();
      if ((inventory[item] ?? 0) >= target) return;
      if (ancestors.includes(item) || ancestors.length > 32) throw new Error(`No acyclic acquisition route for ${item}`);
      const chain = [...ancestors, item];
      const missing = target - (inventory[item] ?? 0);
      const source = smeltingSources[item];
      if (source) {
        await station('furnace', chain);
        for (let remaining = missing; remaining > 0; remaining -= 64) {
          const batch = Math.min(64, remaining);
          await ensure(source, batch, chain);
          await ensure('coal', Math.ceil(batch / 8), chain);
          progress(`Smelt ${batch} ${source} into ${item}`);
          await requireAction(this.minecraft.smeltItem({ input: source, fuel: 'coal', amount: batch }));
        }
      } else {
        const sources = this.catalog.sources(item);
        // Prefer natural sources to expensive reversible block-packing recipes (e.g. diamond_block -> diamonds).
        const natural = sources.filter((name) => name.endsWith('_ore') || name.endsWith('_log') || ['stone', 'cobblestone', 'dirt', 'grass_block', 'sand', 'gravel'].includes(name));
        const recipe = this.catalog.choose(item, inventory, chain, (await this.minecraft.getWorldState()).nearbyUsefulBlocks.map((block) => block.name));
        if (natural.length || !recipe) {
          if (!sources.length) throw new Error(`No implemented mining/crafting/smelting source for ${item}`);
          const requiredTool = this.catalog.toolFor(natural[0] ?? sources[0]!, inventory);
          if (requiredTool) { await ensure(requiredTool, 1, chain); await requireAction(this.minecraft.equipItem(requiredTool, 'hand')); }
          progress(`Collect ${missing} ${item}`);
          await requireAction(this.minecraft.collectResource(item, missing));
        } else {
          const repeats = Math.ceil(missing / recipe.count);
          for (const [ingredient, amount] of Object.entries(recipe.ingredients)) await ensure(ingredient, amount * repeats, chain);
          if (recipe.table) await station('crafting_table', chain);
          // Creating the station can consume ingredients; re-check them instead of crafting from stale counts.
          for (const [ingredient, amount] of Object.entries(recipe.ingredients)) await ensure(ingredient, amount * repeats, chain);
          progress(`Craft ${missing} ${item}`);
          await requireAction(this.minecraft.craftItem(item, missing));
        }
      }
      // Leave time for authoritative state packets on controllers whose result precedes their inventory snapshot.
      for (let attempt = 0; attempt < 10; attempt++) {
        inventory = await counts();
        if ((inventory[item] ?? 0) >= target) return;
        await delay(100, undefined, { signal });
      }
      throw new Error(`Inventory verification failed: need ${target} ${item}, have ${inventory[item] ?? 0}`);
    };
    try {
      for (const item of targets) {
        await ensure(item, spec.amount, []);
        const destination = armorDestination(item);
        if (spec.equip && destination) { progress(`Equip ${item}`); await requireAction(this.minecraft.equipItem(item, destination)); }
      }
      check();
      const final = await this.minecraft.getWorldState();
      check();
      if (targets.some((item) => (inventoryCounts(final)[item] ?? 0) < spec.amount
        || (spec.equip && armorDestination(item) && !final.equippedItems.some((equipped) => equipped.slot >= 2 && equipped.slot <= 5 && equipped.name === item)))) throw new Error('Final inventory/equipment does not satisfy the goal');
      saved.state = 'completed'; this.memory.updateGoal(goalId, 'completed', JSON.stringify(saved));
      return { success: true, action: 'acquire_item', data: { goalId, targets, amount: spec.amount, equipped: spec.equip, verified: true } };
    } catch (error) {
      saved.state = signal.aborted ? 'paused' : 'blocked'; saved.step = error instanceof Error ? error.message : String(error);
      this.memory.updateGoal(goalId, 'active', JSON.stringify(saved));
      return { success: false, action: 'acquire_item', reason: saved.step, data: { goalId, state: saved.state, resumable: true } };
    } finally { signal.removeEventListener('abort', paused); }
  }

  async resume(id: string, signal: AbortSignal): Promise<ActionResult> {
    const goal = this.memory.getGoals(this.minecraft.serverId).find((g) => g.id === id && g.serverId === this.minecraft.serverId);
    if (!goal) return { success: false, action: 'resume_item_goal', reason: 'No active item goal with that ID in this world' };
    try {
      const saved = JSON.parse(goal.notes) as SavedGoal;
      if (saved.kind !== 'item-acquisition-v1' || !saved.spec || typeof saved.spec.item !== 'string' || typeof saved.spec.equip !== 'boolean') throw new Error('Not a valid item goal');
      return this.run(saved.spec, signal, id);
    } catch { return { success: false, action: 'resume_item_goal', reason: 'Stored goal is not a supported item-acquisition goal' }; }
  }
}

import { setTimeout as delay } from 'node:timers/promises';
import type { ActionResult, MineRequest, WorldState, Position } from '../../types.js';
import { RecipeCatalog } from '../../../skills/recipeCatalog.js';
import { inventoryCounts } from '../../../skills/itemGoals.js';

type Request = (action: string, args: Record<string, unknown>, timeout?: number) => Promise<ActionResult>;
export class FabricSkills {
  private readonly catalog = new RecipeCatalog();
  constructor(private readonly request: Request, private readonly world: () => Promise<WorldState>) {}

  async craft(item: string, amount: number, signal: AbortSignal): Promise<ActionResult> {
    signal.throwIfAborted();
    const inventory = inventoryCounts(await this.world());
    const recipes = this.catalog.recipes(item);
    const recipe = recipes.find((r) => Object.entries(r.ingredients).every(([name, count]) => (inventory[name] ?? 0) >= count * Math.ceil(amount / r.count)));
    if (!recipe) return { success: false, action: 'craft_item', reason: 'No recipe with sufficient ingredients', data: { recipes: recipes.slice(0, 5) } };
    signal.throwIfAborted();
    return this.request('craft_item', { item, amount, grid: recipe.grid, output_count: recipe.count, table: recipe.table });
  }

  async mine(request: MineRequest, signal: AbortSignal): Promise<ActionResult> {
    signal.throwIfAborted();
    let position = request.position;
    if (!position) {
      const found = await this.request('find_block', { block: request.block, radius: 16 }); signal.throwIfAborted();
      if (!found.success || !found.data?.position) return { ...found, action: 'mine_block' };
      position = found.data.position as Position;
    }
    const current = await this.world(); signal.throwIfAborted();
    if (Math.hypot(position.x - current.position.x, position.y - current.position.y, position.z - current.position.z) <= 4) {
      const attempted = await this.request('mine_block', { ...request, position }); signal.throwIfAborted();
      if (attempted.success || !/visible|reach|closer/i.test(attempted.reason ?? '')) return attempted;
    }
    const moved = await this.request('move_near', { position, radius: 1.5, can_dig: true }); signal.throwIfAborted();
    if (!moved.success) return { ...moved, action: 'mine_block' };
    return this.request('mine_block', { ...request, position });
  }

  async collect(resource: string, amount: number, signal: AbortSignal): Promise<ActionResult> {
    if (!this.catalog.known(resource) || !Number.isInteger(amount) || amount < 1 || amount > 2304) return { success: false, action: 'collect_resource', reason: 'Unknown item or invalid amount' };
    const sources = this.catalog.sources(resource);
    if (!sources.length) return { success: false, action: 'collect_resource', reason: 'This item has no supported block source; use acquire_item for crafting prerequisites' };
    const start = (inventoryCounts(await this.world())[resource] ?? 0);
    let exploration = 0, leg = 0;
    let failures = 0;
    while (true) {
      signal.throwIfAborted();
      const world = await this.world();
      const collected = (inventoryCounts(world)[resource] ?? 0) - start;
      if (collected >= amount) return { success: true, action: 'collect_resource', data: { resource, collected, verified: true } };
      if (!world.inventory.freeSlots && !world.inventory.items.some((item) => item.name === resource && item.count < 64)) return { success: false, action: 'collect_resource', reason: 'Inventory has no room for this resource', data: { collected } };
      let found: ActionResult | undefined;
      for (const block of sources) {
        signal.throwIfAborted();
        const candidate = await this.request('find_block', { block, radius: 16 });
        if (candidate.success) { found = candidate; break; }
      }
      signal.throwIfAborted();
      if (found?.data?.position) {
        const result = await this.mine({ position: found.data.position as Position, block: String(found.data.name) }, signal);
        signal.throwIfAborted();
        if (!result.success && (inventoryCounts(await this.world())[resource] ?? 0) - start <= collected) return { ...result, action: 'collect_resource', data: { collected } };
        await delay(250, undefined, { signal });
        await this.request('pickup_items', { radius: 8 }); signal.throwIfAborted();
        const after = (inventoryCounts(await this.world())[resource] ?? 0) - start;
        failures = after > collected ? 0 : failures + 1;
        if (failures >= 3) return { success: false, action: 'collect_resource', reason: 'Blocks were removed but inventory did not increase; check tool, drops, inventory and server protections', data: { collected: after } };
      } else {
        // Stair-step toward ore-bearing depth, then extend branches; never teleport or assume hidden ore exists.
        const ore = sources.some((name) => name.endsWith('_ore'));
        const depth = ['diamond', 'redstone', 'lapis_lazuli'].includes(resource) ? -54 : ore ? 16 : Math.floor(world.position.y);
        // Expanding spiral avoids endlessly revisiting the same four corridors.
        if (++exploration > 8 + 2 * Math.floor(leg / 2)) { leg++; exploration = 1; }
        const heading = leg % 4;
        const [dx, dz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][heading]!;
        const distance = ore && world.position.y > depth + 1 ? 3 : 8;
        const position = { x: Math.floor(world.position.x) + dx! * distance + 0.5,
          y: ore && world.position.y > depth + 1 ? Math.floor(world.position.y) - 1 : Math.floor(world.position.y),
          z: Math.floor(world.position.z) + dz! * distance + 0.5 };
        const moved = await this.request('move_to', { position, can_dig: ore, radius: 0.8 }); signal.throwIfAborted();
        if (!moved.success) return { ...moved, action: 'collect_resource', data: { collected, searchingFor: resource } };
      }
      await delay(100, undefined, { signal });
    }
  }
}

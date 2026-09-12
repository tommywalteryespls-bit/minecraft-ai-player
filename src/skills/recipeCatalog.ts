import { createRequire } from 'node:module';

export interface CraftRecipe { output: string; count: number; grid: (string | null)[][]; ingredients: Record<string, number>; table: boolean }
interface Item { id: number; name: string }
interface Block { name: string; drops: (number | { drop: number })[]; harvestTools?: Record<string, boolean>; diggable: boolean }
interface RecipeData { inShape?: (number | null)[][]; ingredients?: number[]; result: { id: number; count: number } }
interface Data { items: Record<number, Item>; itemsByName: Record<string, Item>; blocksArray: Block[]; recipes: Record<number, RecipeData[]>; version: { minecraftVersion: string } }

/** Uses the same vanilla data dependency as our installed Mineflayer, never model-invented recipes. */
export class RecipeCatalog {
  private readonly data: Data;
  constructor() {
    const require = createRequire(import.meta.url);
    const mineflayerRequire = createRequire(require.resolve('mineflayer'));
    this.data = (mineflayerRequire('minecraft-data') as (version: string) => Data)('1.21.11');
    if (this.data?.version.minecraftVersion !== '1.21.11') throw new Error('Minecraft 1.21.11 recipe data is unavailable');
  }
  known(item: string): boolean { return Boolean(this.data.itemsByName[item]); }
  recipes(item: string): CraftRecipe[] {
    const id = this.data.itemsByName[item]?.id;
    if (id === undefined) return [];
    return (this.data.recipes[id] ?? []).flatMap((recipe) => {
      const width = (recipe.ingredients?.length ?? 0) <= 4 ? 2 : 3;
      const shape = recipe.inShape ?? (recipe.ingredients ? Array.from({ length: Math.ceil(recipe.ingredients.length / width) }, (_, row) => recipe.ingredients!.slice(row * width, row * width + width)) : []);
      if (!shape.length || shape.length > 3 || shape.some((row) => row.length > 3)) return [];
      const ingredients: Record<string, number> = {};
      let valid = true;
      const grid = shape.map((row) => row.map((id) => {
        if (id === null || id === -1) return null;
        const name = this.data.items[id]?.name;
        if (!name) { valid = false; return null; }
        ingredients[name] = (ingredients[name] ?? 0) + 1;
        return name;
      }));
      return valid ? [{ output: item, count: recipe.result.count, grid, ingredients, table: grid.length > 2 || grid.some((row) => row.length > 2) }] : [];
    });
  }
  choose(item: string, inventory: Record<string, number>, ancestors: readonly string[] = [], nearby: readonly string[] = []): CraftRecipe | undefined {
    return this.recipes(item).filter((r) => !Object.keys(r.ingredients).some((name) => name === item || ancestors.includes(name)))
      .sort((a, b) => this.cost(a, inventory, nearby) - this.cost(b, inventory, nearby))[0];
  }
  private cost(recipe: CraftRecipe, inventory: Record<string, number>, nearby: readonly string[]): number {
    return Object.entries(recipe.ingredients).reduce((sum, [name, n]) => sum + Math.max(0, n - (inventory[name] ?? 0))
      * (name.endsWith('_block') || name.includes('netherite') ? 1000 : name.includes('stripped_') ? 20
        : name.endsWith('_planks') ? ((inventory[name.replace('_planks', '_log')] ?? 0) > 0 || nearby.includes(name.replace('_planks', '_log')) ? 0.2 : name === 'oak_planks' ? 1 : 2) : 1), 0);
  }
  sources(item: string): string[] {
    const id = this.data.itemsByName[item]?.id;
    return this.data.blocksArray.filter((b) => b.diggable && b.drops?.some((drop) => (typeof drop === 'number' ? drop : drop.drop) === id))
      .map((b) => b.name).filter((name) => !name.includes('potted_') && !name.includes('wall_'));
  }
  toolFor(block: string, inventory: Record<string, number>): string | undefined {
    const tools = this.data.blocksArray.find((b) => b.name === block)?.harvestTools;
    if (!tools) return undefined;
    const names = Object.keys(tools).map((id) => this.data.items[Number(id)]?.name).filter((name): name is string => Boolean(name));
    return names.find((name) => (inventory[name] ?? 0) > 0)
      ?? ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].find((name) => names.includes(name));
  }
}

export const smeltingSources: Record<string, string> = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand',
  stone: 'cobblestone', smooth_stone: 'stone', charcoal: 'oak_log', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken'
};

export const armorSets: Record<string, string[]> = Object.fromEntries(['diamond', 'iron', 'golden', 'leather'].map((material) =>
  [`${material}_armor`, ['helmet', 'chestplate', 'leggings', 'boots'].map((piece) => `${material}_${piece}`)]));

export function armorDestination(item: string): 'head' | 'torso' | 'legs' | 'feet' | undefined {
  return item.endsWith('_helmet') ? 'head' : item.endsWith('_chestplate') ? 'torso' : item.endsWith('_leggings') ? 'legs' : item.endsWith('_boots') ? 'feet' : undefined;
}

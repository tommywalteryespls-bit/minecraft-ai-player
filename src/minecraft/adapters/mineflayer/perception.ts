import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type {
  ActionState,
  EnvironmentalThreat,
  InventoryItem,
  InventoryState,
  PerceivedBlock,
  PerceivedEntity,
  WorldState
} from '../../types.js';
import { toPosition } from './movement.js';

const hostileNames = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'witch', 'slime', 'magma_cube', 'enderman', 'blaze', 'ghast', 'phantom', 'pillager', 'vindicator',
  'evoker', 'ravager', 'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite', 'piglin_brute',
  'hoglin', 'zoglin', 'wither_skeleton', 'warden', 'breeze'
]);

const passiveNames = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule', 'villager', 'wandering_trader',
  'wolf', 'cat', 'ocelot', 'fox', 'bee', 'goat', 'camel', 'llama', 'panda', 'turtle', 'frog', 'sniffer',
  'cod', 'salmon', 'squid', 'glow_squid', 'dolphin', 'axolotl'
]);

const usefulBlockNames = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log',
  'cherry_log', 'pale_oak_log', 'stone', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
  'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore',
  'lapis_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'crafting_table', 'furnace',
  'chest', 'barrel', 'white_bed', 'water', 'lava'
];

export function inventoryState(bot: Bot): InventoryState {
  const items = bot.inventory.items().map<InventoryItem>((item) => ({
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    slot: item.slot
  }));
  const storageSlots = bot.inventory.slots.slice(9, 45);
  return { items, freeSlots: storageSlots.filter((item) => item === null).length };
}

export function perceiveWorld(input: {
  bot: Bot;
  serverId: string;
  entityRadius: number;
  playerRadius: number;
  blockRadius: number;
  currentAction: ActionState;
}): WorldState {
  const { bot } = input;
  const position = bot.entity?.position;
  if (!position) throw new Error('Minecraft player has not spawned');
  const entities = Object.values(bot.entities)
    .filter((entity) => entity !== bot.entity && entity.position)
    .map((entity) => perceiveEntity(bot, entity))
    .filter((entity) => entity.distance <= (entity.kind === 'player' ? input.playerRadius : input.entityRadius));
  const nearbyPlayers = entities.filter((entity) => entity.kind === 'player').sort(byDistance);
  const nearbyHostiles = entities.filter((entity) => entity.kind === 'hostile').sort(byDistance);
  const nearbyPassiveMobs = entities.filter((entity) => entity.kind === 'passive').sort(byDistance);
  const droppedItems = entities.filter((entity) => entity.kind === 'item').sort(byDistance);
  const nearbyUsefulBlocks = scanUsefulBlocks(bot, input.blockRadius);
  const inventory = inventoryState(bot);
  const equippedItems = bot.inventory.slots
    .map((item, slot) => (item && (slot === bot.quickBarSlot + 36 || (slot >= 5 && slot <= 8) || slot === 45)
      ? { name: item.name, displayName: item.displayName, count: item.count, slot }
      : null))
    .filter((item): item is InventoryItem => item !== null);
  const environmentalThreats = detectThreats(bot, nearbyHostiles);
  return {
    serverId: input.serverId,
    connected: true,
    dimension: String(bot.game.dimension),
    day: Number(bot.time.day ?? Math.floor(bot.time.age / 24_000)),
    time: Number(bot.time.timeOfDay),
    position: toPosition(position),
    health: bot.health,
    hunger: bot.food,
    armor: armorPoints(inventory.items),
    inventory,
    equippedItems,
    nearbyPlayers,
    nearbyHostiles,
    nearbyPassiveMobs,
    nearbyUsefulBlocks,
    droppedItems,
    environmentalThreats,
    currentAction: input.currentAction,
    currentGoals: []
  };
}

function perceiveEntity(bot: Bot, entity: Entity): PerceivedEntity {
  const rawName = String(entity.name ?? entity.displayName ?? entity.type ?? 'unknown').toLowerCase();
  const name = rawName.replace(/^minecraft:/, '').replaceAll(' ', '_');
  const isPlayer = entity.type === 'player' || Boolean(entity.username);
  const kind: PerceivedEntity['kind'] = isPlayer
    ? 'player'
    : entity.name === 'item' || entity.type === 'object' && name === 'item'
      ? 'item'
      : hostileNames.has(name)
        ? 'hostile'
        : passiveNames.has(name)
          ? 'passive'
          : 'other';
  const result: PerceivedEntity = {
    id: String(entity.id),
    name,
    kind,
    position: toPosition(entity.position),
    distance: Math.round(bot.entity.position.distanceTo(entity.position) * 10) / 10
  };
  if (entity.username) result.username = entity.username;
  if (entity.uuid) result.uuid = entity.uuid;
  return result;
}

function scanUsefulBlocks(bot: Bot, radius: number): PerceivedBlock[] {
  const ids = usefulBlockNames
    .map((name) => bot.registry.blocksByName[name]?.id)
    .filter((id): id is number => id !== undefined);
  if (!ids.length) return [];
  return bot
    .findBlocks({ matching: ids, maxDistance: radius, count: 48 })
    .map((position) => {
      const block = bot.blockAt(position);
      return block
        ? {
            name: block.name,
            position: toPosition(position),
            distance: Math.round(bot.entity.position.distanceTo(position) * 10) / 10
          }
        : null;
    })
    .filter((block): block is PerceivedBlock => block !== null)
    .sort((a, b) => a.distance - b.distance);
}

function detectThreats(bot: Bot, hostiles: PerceivedEntity[]): EnvironmentalThreat[] {
  const threats: EnvironmentalThreat[] = [];
  const feet = bot.blockAt(bot.entity.position.floored());
  if (feet?.name.includes('lava')) threats.push({ type: 'lava', severity: 'critical', description: 'Standing in lava' });
  if (bot.food <= 4) threats.push({ type: 'starvation', severity: 'critical', description: `Hunger is ${bot.food}/20` });
  if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 3) {
    threats.push({ type: 'drowning', severity: 'critical', description: 'Almost out of air underwater' });
  }
  for (const hostile of hostiles.slice(0, 5)) {
    const severity = hostile.name.includes('creeper') && hostile.distance <= 5 || hostile.distance <= 2.5 ? 'critical' : 'medium';
    threats.push({
      type: 'hostile',
      severity,
      description: `${hostile.name} is ${hostile.distance} blocks away`,
      sourceId: hostile.id
    });
  }
  return threats;
}

function armorPoints(items: InventoryItem[]): number {
  const values: Record<string, number> = { leather: 1, golden: 2, chainmail: 2, iron: 2, diamond: 3, netherite: 3 };
  return items
    .filter((item) => item.slot >= 5 && item.slot <= 8)
    .reduce((sum, item) => sum + (Object.entries(values).find(([material]) => item.name.startsWith(material))?.[1] ?? 0), 0);
}

function byDistance(a: PerceivedEntity, b: PerceivedEntity): number {
  return a.distance - b.distance;
}

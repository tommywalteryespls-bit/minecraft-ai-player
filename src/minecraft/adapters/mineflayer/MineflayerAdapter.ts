import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import pathfinderPackage from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { Logger } from 'pino';
import type { AppConfig } from '../../../config.js';
import type { MinecraftAgent } from '../../MinecraftAgent.js';
import type { ServerProfile } from '../../serverProfiles/profileTypes.js';
import type {
  ActionResult,
  ActionState,
  ContainerRequest,
  InventoryState,
  MineRequest,
  MinecraftEvent,
  MinecraftEventListener,
  MoveOptions,
  PlaceBlockRequest,
  Position,
  SmeltRequest,
  WorldState
} from '../../types.js';
import { ServerRules } from '../../../server/serverRules.js';
import { errorMessage } from '../../../utils/errors.js';
import { sleep } from '../../../utils/sleep.js';
import { withTimeout } from '../../../utils/timeout.js';
import { SimpleVoiceChatProvider } from './SimpleVoiceChatProvider.js';
import { createMineflayerBot } from './createBot.js';
import { MovementController, toPosition } from './movement.js';
import { inventoryState, perceiveWorld } from './perception.js';

const foodScores: Record<string, number> = {
  cooked_beef: 8, cooked_porkchop: 8, rabbit_stew: 10, cooked_mutton: 6, cooked_salmon: 6,
  cooked_chicken: 6, mushroom_stew: 6, bread: 5, baked_potato: 5, cooked_cod: 5,
  golden_carrot: 6, apple: 4, carrot: 3, potato: 1, sweet_berries: 2, melon_slice: 2,
  dried_kelp: 1, pumpkin_pie: 8, beetroot_soup: 6
};

const resourceBlocks: Record<string, string[]> = {
  log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'],
  oak_log: ['oak_log'],
  cobblestone: ['stone', 'cobblestone'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  iron_ore: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore']
};

const { pathfinder } = pathfinderPackage;

export class MineflayerAdapter implements MinecraftAgent {
  readonly serverId: string;
  private bot: Bot | null = null;
  private movement: MovementController | null = null;
  private listeners = new Set<MinecraftEventListener>();
  private currentAction: ActionState = 'IDLE';
  private following = false;
  private lastDay = -1;
  private previousHealth = 20;
  private intentionallyDisconnected = false;
  private voiceProvider: SimpleVoiceChatProvider | null = null;

  constructor(
    private readonly profile: ServerProfile,
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.serverId = profile.id;
  }

  get connected(): boolean {
    return Boolean(this.bot?.entity);
  }

  async connect(): Promise<void> {
    if (this.bot) throw new Error(`Already connected or connecting to ${this.serverId}`);
    this.intentionallyDisconnected = false;
    const bot = createMineflayerBot(this.profile, this.config, this.logger);
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    this.movement = new MovementController(bot, this.config.actionTimeoutMs);
    if (this.config.voiceEnabled && this.config.voiceMode !== 'browser' && this.profile.capabilities.voiceChat) {
      try {
        this.voiceProvider = new SimpleVoiceChatProvider(this.config.dataDir, this.logger, (utterance) => {
          const username = utterance.username ?? this.usernameForUuid(utterance.senderId);
          this.emit({
            type: 'PLAYER_SPOKE',
            username,
            uuid: utterance.senderId,
            distance: utterance.distance,
            audio: utterance.pcm,
            audioFormat: 'pcm_s16le_48000_mono'
          });
        }, undefined, this.profile.host);
        this.voiceProvider.attach(bot);
      } catch (error) {
        this.logger.warn({ error }, 'Simple Voice Chat plugin could not be loaded; voice is disabled for this session');
        this.voiceProvider = null;
      }
    }
    this.wireEvents(bot);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          callback();
        };
        bot.once('spawn', () => settle(resolve));
        bot.once('error', (error) => settle(() => reject(error)));
        bot.once('kicked', (reason) => settle(() => reject(new Error(`Kicked: ${formatReason(reason)}`))));
        bot.once('end', (reason) => settle(() => reject(new Error(`Disconnected before spawn: ${reason}`))));
      });
    } catch (error) {
      await this.voiceProvider?.detach().catch(() => undefined);
      this.voiceProvider = null;
      try {
        bot.quit();
      } catch {
        // The transport may already be closed.
      }
      if (this.bot === bot) this.bot = null;
      this.movement = null;
      throw error;
    }
    this.previousHealth = bot.health;
    this.lastDay = Number(bot.time.day ?? 0);
    this.emit({ type: 'SERVER_CONNECTED', position: toPosition(bot.entity.position) });
  }

  async disconnect(reason = 'Controller disconnect'): Promise<void> {
    this.intentionallyDisconnected = true;
    const bot = this.bot;
    if (!bot) return;
    await this.cancelCurrentAction(reason);
    await this.voiceProvider?.detach();
    this.voiceProvider = null;
    try {
      bot.quit();
    } finally {
      this.bot = null;
      this.movement = null;
    }
  }

  async cancelCurrentAction(_reason?: string): Promise<void> {
    const bot = this.bot;
    this.following = false;
    this.movement?.cancel();
    if (bot) {
      try {
        bot.stopDigging();
      } catch {
        // No dig operation was active.
      }
      bot.deactivateItem();
      bot.clearControlStates();
    }
    this.currentAction = 'IDLE';
  }

  subscribe(listener: MinecraftEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getWorldState(): Promise<WorldState> {
    const bot = this.requireBot();
    return perceiveWorld({
      bot,
      serverId: this.serverId,
      entityRadius: this.config.entityScanRadius,
      playerRadius: this.config.playerScanRadius,
      blockRadius: this.config.blockScanRadius,
      currentAction: this.currentAction
    });
  }

  async getInventory(): Promise<InventoryState> {
    return inventoryState(this.requireBot());
  }

  async moveTo(position: Position, options?: MoveOptions): Promise<ActionResult> {
    return this.run('MOVING', 'move_to', async () => this.requireMovement().moveTo(position, options));
  }

  async moveNear(position: Position, radius: number, options?: MoveOptions): Promise<ActionResult> {
    return this.run('MOVING', 'move_near', async () => this.requireMovement().moveNear(position, radius, options));
  }

  async followPlayer(username: string): Promise<ActionResult> {
    return this.run('FOLLOWING', 'follow_player', async () => {
      const bot = this.requireBot();
      const player = this.findPlayer(username);
      if (!player) return this.failure('follow_player', `Player '${username}' is not visible`);
      this.following = true;
      this.requireMovement().follow(player, 2);
      return this.success('follow_player', { username, uuid: player.uuid });
    }, true);
  }

  async stopFollowing(): Promise<ActionResult> {
    this.following = false;
    this.requireMovement().cancel();
    this.currentAction = 'IDLE';
    return this.success('stop_following');
  }

  async lookAt(target: Position): Promise<ActionResult> {
    return this.run('INTERACTING', 'look_at', async () => {
      const bot = this.requireBot();
      await withTimeout(bot.lookAt(new Vec3(target.x, target.y, target.z), true), 5000, 'look_at');
      return this.success('look_at', { target });
    });
  }

  async findBlock(block: string, radius = this.config.blockScanRadius): Promise<ActionResult> {
    const bot = this.requireBot();
    const candidates = this.blockNames(block);
    const ids = candidates.map((name) => bot.registry.blocksByName[name]?.id).filter((id): id is number => id !== undefined);
    if (!ids.length) return this.failure('find_block', `Unknown block '${block}' for Minecraft ${bot.version}`);
    const found = bot.findBlock({ matching: ids, maxDistance: radius });
    return found
      ? this.success('find_block', { block: found.name, position: toPosition(found.position), distance: bot.entity.position.distanceTo(found.position) })
      : this.failure('find_block', `No ${block} found within ${radius} blocks`);
  }

  async mineBlock(request: MineRequest): Promise<ActionResult> {
    new ServerRules(this.profile).assertBreakingAllowed();
    return this.run('MINING', 'mine_block', async () => {
      const bot = this.requireBot();
      let block: Block | null = null;
      if (request.position) block = bot.blockAt(toVec3(request.position));
      if (!block && request.block) {
        const names = this.blockNames(request.block);
        const ids = names.map((name) => bot.registry.blocksByName[name]?.id).filter((id): id is number => id !== undefined);
        block = ids.length ? bot.findBlock({ matching: ids, maxDistance: this.config.blockScanRadius }) : null;
      }
      if (!block) return this.failure('mine_block', 'Requested block was not found');
      await this.digBlock(block);
      return this.success('mine_block', { block: block.name, position: toPosition(block.position) });
    });
  }

  async collectResource(resource: string, amount: number): Promise<ActionResult> {
    new ServerRules(this.profile).assertBreakingAllowed();
    return this.run('MINING', 'collect_resource', async () => {
      const bot = this.requireBot();
      const normalized = normalizeName(resource);
      const starting = countInventory(bot, normalized);
      let attempts = 0;
      let lastFailure = '';
      while (countInventory(bot, normalized) - starting < amount && attempts < Math.max(8, amount * 2)) {
        attempts += 1;
        const names = this.blockNames(normalized);
        const ids = names.map((name) => bot.registry.blocksByName[name]?.id).filter((id): id is number => id !== undefined);
        if (!ids.length) {
          lastFailure = `Unknown resource or block '${resource}'`;
          break;
        }
        const block = bot.findBlock({ matching: ids, maxDistance: this.config.blockScanRadius });
        if (!block) {
          lastFailure = `No ${resource} found within ${this.config.blockScanRadius} blocks`;
          break;
        }
        try {
          await this.digBlock(block);
          await sleep(350);
          await this.pickupItems(8);
        } catch (error) {
          lastFailure = errorMessage(error);
        }
      }
      const collected = Math.max(0, countInventory(bot, normalized) - starting);
      return collected >= amount
        ? this.success('collect_resource', { resource: normalized, requested: amount, collected, attempts })
        : {
            ...this.failure('collect_resource', lastFailure || `Collected only ${collected}/${amount}`),
            data: { resource: normalized, requested: amount, collected, attempts }
          };
    });
  }

  async pickupItems(radius = 12): Promise<ActionResult> {
    return this.run('MOVING', 'pickup_items', async () => {
      const bot = this.requireBot();
      const before = bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
      let movedTo = 0;
      for (const entity of Object.values(bot.entities)
        .filter((candidate) => candidate.name === 'item' && candidate.position.distanceTo(bot.entity.position) <= radius)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
        .slice(0, 12)) {
        await this.requireMovement().moveNear(toPosition(entity.position), 0, { timeoutMs: 8000, canDig: false }).catch(() => undefined);
        movedTo += 1;
        await sleep(250);
      }
      const after = bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
      return this.success('pickup_items', { itemEntitiesVisited: movedTo, itemCountDelta: after - before });
    });
  }

  async craftItem(item: string, amount: number): Promise<ActionResult> {
    return this.run('CRAFTING', 'craft_item', async () => {
      const bot = this.requireBot();
      const name = normalizeName(item);
      const itemDefinition = bot.registry.itemsByName[name];
      if (!itemDefinition) return this.failure('craft_item', `Unknown item '${item}' for Minecraft ${bot.version}`);
      let craftingTable: Block | null = null;
      let recipes = bot.recipesFor(itemDefinition.id, null, 1, null);
      if (!recipes.length) {
        const tableId = bot.registry.blocksByName.crafting_table?.id;
        craftingTable = tableId === undefined ? null : bot.findBlock({ matching: tableId, maxDistance: this.config.blockScanRadius });
        if (!craftingTable) {
          return this.failure('craft_item', 'No inventory recipe is available and no crafting table is nearby');
        }
        await this.requireMovement().getAdjacentTo(toPosition(craftingTable.position));
        recipes = bot.recipesFor(itemDefinition.id, null, 1, craftingTable);
      }
      const recipe = recipes[0];
      if (!recipe) return this.failure('craft_item', `No craftable recipe for '${item}' with the current inventory`);
      const before = countInventory(bot, name);
      const outputPerCraft = Math.max(1, recipe.result?.count ?? 1);
      const repetitions = Math.ceil(amount / outputPerCraft);
      await withTimeout(bot.craft(recipe, repetitions, craftingTable ?? undefined), this.config.actionTimeoutMs, 'craft_item');
      const crafted = Math.max(0, countInventory(bot, name) - before);
      return this.success('craft_item', { item: name, requested: amount, crafted, usedCraftingTable: Boolean(craftingTable) });
    });
  }

  async equipItem(
    item: string,
    destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet' = 'hand'
  ): Promise<ActionResult> {
    return this.run('INTERACTING', 'equip_item', async () => {
      const bot = this.requireBot();
      const inventoryItem = findInventoryItem(bot, item);
      if (!inventoryItem) return this.failure('equip_item', `Item '${item}' is not in inventory`);
      await bot.equip(inventoryItem, destination);
      return this.success('equip_item', { item: inventoryItem.name, destination });
    });
  }

  async eatBestFood(): Promise<ActionResult> {
    return this.run('EATING', 'eat_best_food', async () => {
      const bot = this.requireBot();
      if (bot.food >= 20) return this.failure('eat_best_food', 'Hunger is already full');
      const food = bot.inventory.items()
        .filter((item) => foodScores[item.name] !== undefined)
        .sort((a, b) => (foodScores[b.name] ?? 0) - (foodScores[a.name] ?? 0))[0];
      if (!food) return this.failure('eat_best_food', 'No known edible food is in inventory');
      await bot.equip(food, 'hand');
      await withTimeout(bot.consume(), 10_000, 'eat_best_food');
      return this.success('eat_best_food', { item: food.name, hunger: bot.food });
    });
  }

  async attackEntity(entityId: string): Promise<ActionResult> {
    new ServerRules(this.profile).assertCombatAllowed();
    return this.run('COMBAT', 'attack_entity', async () => {
      const bot = this.requireBot();
      if (bot.health <= 6) return this.failure('attack_entity', 'Health is too low; flee instead');
      const entity = bot.entities[Number(entityId)];
      if (!entity) return this.failure('attack_entity', `Entity ${entityId} is no longer visible`);
      await this.equipBestWeapon();
      const startedAt = Date.now();
      while (bot.entities[entity.id] && Date.now() - startedAt < 15_000 && bot.health > 6) {
        const target = bot.entities[entity.id];
        if (!target) break;
        if (bot.entity.position.distanceTo(target.position) > 3) {
          await this.requireMovement().moveNear(toPosition(target.position), 2, { timeoutMs: 5000, canDig: false });
        }
        bot.attack(target);
        await sleep(650);
      }
      return this.success('attack_entity', { entityId, defeatedOrGone: !bot.entities[entity.id], health: bot.health });
    });
  }

  async attackNearestHostile(): Promise<ActionResult> {
    const state = await this.getWorldState();
    const hostile = state.nearbyHostiles[0];
    return hostile ? this.attackEntity(hostile.id) : this.failure('attack_nearest_hostile', 'No hostile mob is nearby');
  }

  async fleeFrom(threatId: string): Promise<ActionResult> {
    return this.run('FLEEING', 'flee', async () => {
      const bot = this.requireBot();
      const threat = bot.entities[Number(threatId)];
      if (!threat) return this.failure('flee', `Threat ${threatId} is no longer visible`);
      return this.requireMovement().fleeFrom(toPosition(threat.position));
    });
  }

  async placeBlock(request: PlaceBlockRequest): Promise<ActionResult> {
    new ServerRules(this.profile).assertPlacementAllowed();
    return this.run('BUILDING', 'place_block', async () => {
      const bot = this.requireBot();
      const item = findInventoryItem(bot, request.item);
      if (!item) return this.failure('place_block', `Block item '${request.item}' is not in inventory`);
      const target = toVec3(request.position).floored();
      const targetBlock = bot.blockAt(target);
      if (targetBlock && targetBlock.boundingBox !== 'empty') {
        return this.failure('place_block', `Target ${target} is occupied by ${targetBlock.name}`);
      }
      const placement = request.against
        ? { reference: bot.blockAt(toVec3(request.against).floored()), face: target.minus(toVec3(request.against).floored()) }
        : findPlacementReference(bot, target);
      if (!placement?.reference) return this.failure('place_block', 'No solid adjacent block can support placement');
      await this.requireMovement().getAdjacentTo(toPosition(placement.reference.position));
      await bot.equip(item, 'hand');
      await withTimeout(bot.placeBlock(placement.reference, placement.face), 10_000, 'place_block');
      return this.success('place_block', { item: item.name, position: toPosition(target) });
    });
  }

  async sleep(): Promise<ActionResult> {
    return this.run('SLEEPING', 'sleep', async () => {
      const bot = this.requireBot();
      const bed = bot.findBlock({ matching: (block) => block.name.endsWith('_bed'), maxDistance: 24 });
      if (!bed) return this.failure('sleep', 'No bed found within 24 blocks');
      await this.requireMovement().getAdjacentTo(toPosition(bed.position));
      await withTimeout(bot.sleep(bed), 10_000, 'sleep');
      return this.success('sleep', { bed: toPosition(bed.position) });
    });
  }

  async inspectContainer(request: ContainerRequest): Promise<ActionResult> {
    return this.withContainer('inspect_container', request, async (container) => ({
      items: container.containerItems().map((item) => ({ name: item.name, count: item.count, slot: item.slot }))
    }));
  }

  async depositItem(request: ContainerRequest): Promise<ActionResult> {
    if (!request.item || !request.amount) return this.failure('deposit_item', 'item and amount are required');
    return this.withContainer('deposit_item', request, async (container, bot) => {
      const item = findInventoryItem(bot, request.item ?? '');
      if (!item) throw new Error(`Item '${request.item}' is not in inventory`);
      await container.deposit(item.type, null, Math.min(request.amount ?? 1, item.count));
      return { item: item.name, amount: Math.min(request.amount ?? 1, item.count) };
    });
  }

  async withdrawItem(request: ContainerRequest): Promise<ActionResult> {
    if (!request.item || !request.amount) return this.failure('withdraw_item', 'item and amount are required');
    return this.withContainer('withdraw_item', request, async (container) => {
      const item = container.containerItems().find((candidate) => candidate.name === normalizeName(request.item ?? ''));
      if (!item) throw new Error(`Item '${request.item}' is not in this container`);
      await container.withdraw(item.type, null, Math.min(request.amount ?? 1, item.count));
      return { item: item.name, amount: Math.min(request.amount ?? 1, item.count) };
    });
  }

  async smeltItem(request: SmeltRequest): Promise<ActionResult> {
    return this.run('INTERACTING', 'smelt_item', async () => {
      const bot = this.requireBot();
      const input = findInventoryItem(bot, request.input);
      if (!input) return this.failure('smelt_item', `Input '${request.input}' is not in inventory`);
      const fuel = request.fuel ? findInventoryItem(bot, request.fuel) : bot.inventory.items().find((item) => /coal|charcoal|planks|log/.test(item.name));
      if (!fuel) return this.failure('smelt_item', 'No requested or known furnace fuel is in inventory');
      const furnaceBlock = request.furnacePosition
        ? bot.blockAt(toVec3(request.furnacePosition))
        : bot.findBlock({ matching: bot.registry.blocksByName.furnace?.id ?? -1, maxDistance: 24 });
      if (!furnaceBlock) return this.failure('smelt_item', 'No furnace found within 24 blocks');
      await this.requireMovement().getAdjacentTo(toPosition(furnaceBlock.position));
      const furnace = await bot.openFurnace(furnaceBlock);
      try {
        const amount = Math.min(request.amount, input.count);
        await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(amount / 8)));
        await furnace.putInput(input.type, null, amount);
        const deadline = Date.now() + Math.min(120_000, 12_000 * amount);
        while (!furnace.outputItem() && Date.now() < deadline) await sleep(500);
        const output = await furnace.takeOutput();
        return output
          ? this.success('smelt_item', { input: input.name, output: output.name, amount: output.count })
          : this.failure('smelt_item', 'Furnace produced no output before timeout');
      } finally {
        furnace.close();
      }
    });
  }

  async sayText(message: string): Promise<ActionResult> {
    const bot = this.requireBot();
    if (!this.profile.capabilities.textChat) return this.failure('say', 'Text chat is disabled in this profile');
    const safe = message.replace(/[\r\n]/g, ' ').slice(0, 240);
    if (safe.trimStart().startsWith('/')) {
      return this.failure('say', 'Commands are restricted to configured server actions');
    }
    bot.chat(safe);
    return this.success('say', { message: safe });
  }

  async executeServerCommand(command: string): Promise<ActionResult> {
    const bot = this.requireBot();
    if (!this.profile.capabilities.textChat) return this.failure('server_command', 'Text chat is disabled in this profile');
    const safe = command.replace(/[\r\n]/g, ' ').slice(0, 240);
    if (!safe.startsWith('/') || safe.length < 2) {
      return this.failure('server_command', 'Configured command must begin with /');
    }
    bot.chat(safe);
    return this.success('server_command', { command: safe });
  }

  async speakAudio(audio: Buffer, mimeType = 'audio/mpeg'): Promise<ActionResult> {
    const bot = this.requireBot();
    if (!this.voiceProvider?.isReady()) return this.failure('speak_audio', 'Simple Voice Chat is unavailable');
    await this.voiceProvider.send(bot, audio, mimeType);
    return this.success('speak_audio', { bytes: audio.byteLength, mimeType });
  }

  voiceStatus(): { connected: boolean; reason?: string } {
    if (!this.config.voiceEnabled) return { connected: false, reason: 'VOICE_ENABLED is false' };
    if (this.config.voiceMode === 'browser') return { connected: false, reason: 'Browser voice is selected; Simple Voice Chat is intentionally disabled. Use the local voice panel.' };
    if (!this.profile.capabilities.voiceChat) return { connected: false, reason: 'Voice chat is disabled in the server profile' };
    if (!this.connected) return { connected: false, reason: 'Minecraft is not connected' };
    if (!this.voiceProvider) return { connected: false, reason: 'Simple Voice Chat plugin is unavailable' };
    return this.voiceProvider.connectionStatus();
  }

  private wireEvents(bot: Bot): void {
    bot.on('spawn', () => this.emit({ type: 'SPAWN', position: toPosition(bot.entity.position) }));
    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      const entity = bot.players[username]?.entity;
      this.emit({
        type: 'CHAT_MESSAGE',
        username,
        uuid: entity?.uuid,
        message,
        position: entity ? toPosition(entity.position) : undefined,
        distance: entity ? bot.entity.position.distanceTo(entity.position) : undefined
      });
    });
    bot.on('health', () => {
      if (bot.health < this.previousHealth) {
        this.emit({ type: 'DAMAGE_TAKEN', data: { previousHealth: this.previousHealth, health: bot.health } });
      }
      this.previousHealth = bot.health;
    });
    bot.on('death', () => {
      let worldState: WorldState | undefined;
      try {
        worldState = perceiveWorld({
          bot,
          serverId: this.serverId,
          entityRadius: this.config.entityScanRadius,
          playerRadius: this.config.playerScanRadius,
          blockRadius: this.config.blockScanRadius,
          currentAction: this.currentAction
        });
      } catch {
        // Position is still preserved even if the final full snapshot is unavailable.
      }
      this.emit({
        type: 'DEATH',
        position: toPosition(bot.entity.position),
        data: worldState ? { worldState } : undefined
      });
    });
    bot.on('respawn', () => this.emit({ type: 'RESPAWN', position: toPosition(bot.entity.position) }));
    bot.on('playerLeft', (player) => this.emit({ type: 'PLAYER_LEFT', username: player.username, uuid: player.uuid }));
    bot.on('time', () => {
      const day = Number(bot.time.day ?? 0);
      if (this.lastDay >= 0 && day > this.lastDay) this.emit({ type: 'NEW_DAY', data: { previousDay: this.lastDay, day } });
      this.lastDay = Math.max(this.lastDay, day);
    });
    bot.on('kicked', (reason) => this.logger.warn({ serverId: this.serverId, reason: formatReason(reason) }, 'Bot was kicked'));
    bot.on('error', (error) => {
      this.logger.error({ serverId: this.serverId, error }, 'Mineflayer error');
      this.emit({ type: 'ERROR', message: error.message });
    });
    bot.on('end', (reason) => {
      const intentional = this.intentionallyDisconnected;
      this.bot = null;
      this.movement = null;
      this.emit({ type: 'SERVER_DISCONNECTED', message: String(reason), data: { intentional } });
    });
    const voiceEvents = bot as unknown as EventEmitter;
    voiceEvents.on('voicechat_connect', () => this.emit({ type: 'VOICE_STARTED' }));
  }

  private async digBlock(block: Block): Promise<void> {
    const bot = this.requireBot();
    if (!bot.canDigBlock(block)) await this.requireMovement().getAdjacentTo(toPosition(block.position));
    const tool = bot.pathfinder.bestHarvestTool(block);
    if (tool) await bot.equip(tool, 'hand');
    await withTimeout(bot.dig(block, true), this.config.actionTimeoutMs, `mine ${block.name}`, () => bot.stopDigging());
  }

  private async equipBestWeapon(): Promise<void> {
    const bot = this.requireBot();
    const weapons = bot.inventory.items().filter((item) => /(_sword|_axe)$/.test(item.name));
    const rank = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    weapons.sort((a, b) => rank.findIndex((value) => a.name.startsWith(value)) - rank.findIndex((value) => b.name.startsWith(value)));
    if (weapons[0]) await bot.equip(weapons[0], 'hand');
  }

  private async withContainer(
    action: string,
    request: ContainerRequest,
    operation: (container: Awaited<ReturnType<Bot['openContainer']>>, bot: Bot) => Promise<Record<string, unknown>>
  ): Promise<ActionResult> {
    return this.run('INTERACTING', action, async () => {
      const bot = this.requireBot();
      const block = bot.blockAt(toVec3(request.position));
      if (!block) return this.failure(action, 'Container block is not loaded');
      await this.requireMovement().getAdjacentTo(toPosition(block.position));
      const container = await bot.openContainer(block);
      try {
        const data = await operation(container, bot);
        return this.success(action, data);
      } catch (error) {
        return this.failure(action, errorMessage(error));
      } finally {
        container.close();
      }
    });
  }

  private findPlayer(username: string): Entity | null {
    const bot = this.requireBot();
    const key = Object.keys(bot.players).find((candidate) => candidate.toLowerCase() === username.toLowerCase());
    return key ? bot.players[key]?.entity ?? null : null;
  }

  private usernameForUuid(uuid?: string): string | undefined {
    if (!uuid || !this.bot) return undefined;
    return Object.values(this.bot.players).find((player) => player.uuid === uuid || player.entity?.uuid === uuid)?.username;
  }

  private blockNames(resource: string): string[] {
    const normalized = normalizeName(resource);
    return resourceBlocks[normalized] ?? [normalized];
  }

  private requireBot(): Bot {
    if (!this.bot?.entity) throw new Error(`Not connected and spawned on ${this.serverId}`);
    return this.bot;
  }

  private requireMovement(): MovementController {
    if (!this.movement) throw new Error('Movement controller is unavailable');
    return this.movement;
  }

  private async run(
    state: ActionState,
    action: string,
    operation: () => Promise<ActionResult>,
    persistent = false
  ): Promise<ActionResult> {
    const started = Date.now();
    this.currentAction = state;
    try {
      const result = await operation();
      return { ...result, durationMs: result.durationMs ?? Date.now() - started, finalPosition: result.finalPosition ?? this.currentPosition() };
    } catch (error) {
      return {
        success: false,
        action,
        reason: errorMessage(error),
        durationMs: Date.now() - started,
        finalPosition: this.currentPosition()
      };
    } finally {
      if (!persistent) this.currentAction = this.following ? 'FOLLOWING' : 'IDLE';
    }
  }

  private success(action: string, data: Record<string, unknown> = {}): ActionResult {
    return { success: true, action, finalPosition: this.currentPosition(), data };
  }

  private failure(action: string, reason: string): ActionResult {
    return { success: false, action, reason, finalPosition: this.currentPosition() };
  }

  private currentPosition(): Position | undefined {
    return this.bot?.entity ? toPosition(this.bot.entity.position) : undefined;
  }

  private emit(event: Omit<MinecraftEvent, 'serverId' | 'timestamp'>): void {
    const complete: MinecraftEvent = {
      ...event,
      serverId: this.serverId,
      timestamp: new Date().toISOString()
    };
    for (const listener of this.listeners) {
      Promise.resolve(listener(complete)).catch((error) => this.logger.error({ error }, 'Minecraft event listener failed'));
    }
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/^minecraft:/, '').trim().replaceAll(' ', '_');
}

function toVec3(position: Position): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

function countInventory(bot: Bot, name: string): number {
  const normalized = normalizeName(name);
  const aliases: Record<string, string[]> = {
    log: resourceBlocks.log ?? [],
    iron_ore: ['raw_iron', 'iron_ore'],
    coal: ['coal'],
    diamond: ['diamond'],
    redstone: ['redstone'],
    lapis_lazuli: ['lapis_lazuli'],
    emerald: ['emerald']
  };
  const names = aliases[normalized] ?? [normalized];
  return bot.inventory.items().filter((item) => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
}

function findInventoryItem(bot: Bot, name: string): Item | undefined {
  const normalized = normalizeName(name);
  return bot.inventory.items().find((item) => item.name === normalized || item.displayName.toLowerCase() === name.toLowerCase());
}

function findPlacementReference(bot: Bot, target: Vec3): { reference: Block; face: Vec3 } | null {
  const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1)];
  for (const offset of faces) {
    const reference = bot.blockAt(target.plus(offset));
    if (reference && reference.boundingBox !== 'empty') return { reference, face: offset.scaled(-1) };
  }
  return null;
}

function formatReason(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object' && 'toString' in reason) return String(reason);
  return JSON.stringify(reason);
}

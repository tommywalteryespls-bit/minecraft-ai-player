import type { MinecraftAgent } from '../../MinecraftAgent.js';
import type {
  ActionResult,
  ContainerRequest,
  InventoryState,
  MineRequest,
  MinecraftEventListener,
  MoveOptions,
  PlaceBlockRequest,
  Position,
  SmeltRequest,
  WorldState
} from '../../types.js';

export class TestMinecraftAgent implements MinecraftAgent {
  readonly serverId: string;
  connected = false;
  private listeners = new Set<MinecraftEventListener>();
  private position: Position = { x: 0, y: 64, z: 0 };
  private inventory: InventoryState = {
    items: [{ name: 'bread', displayName: 'Bread', count: 8, slot: 36 }],
    freeSlots: 35
  };

  constructor(serverId: string) {
    this.serverId = serverId;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emit('SERVER_CONNECTED');
    this.emit('SPAWN');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit('SERVER_DISCONNECTED');
  }

  async cancelCurrentAction(): Promise<void> {}

  subscribe(listener: MinecraftEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getWorldState(): Promise<WorldState> {
    return {
      serverId: this.serverId,
      connected: this.connected,
      dimension: 'overworld',
      day: 1,
      time: 1000,
      position: this.position,
      health: 20,
      hunger: 20,
      armor: 0,
      inventory: this.inventory,
      equippedItems: [],
      nearbyPlayers: [],
      nearbyHostiles: [],
      nearbyPassiveMobs: [],
      nearbyUsefulBlocks: [],
      droppedItems: [],
      environmentalThreats: [],
      currentAction: 'IDLE',
      currentGoals: []
    };
  }

  async getInventory(): Promise<InventoryState> {
    return this.inventory;
  }

  async moveTo(position: Position, _options?: MoveOptions): Promise<ActionResult> {
    this.position = { ...position };
    return this.ok('move_to', { position });
  }

  async moveNear(position: Position, _radius: number, _options?: MoveOptions): Promise<ActionResult> {
    return this.moveTo(position);
  }

  async followPlayer(username: string): Promise<ActionResult> {
    return this.ok('follow_player', { username });
  }

  async stopFollowing(): Promise<ActionResult> {
    return this.ok('stop_following');
  }

  async lookAt(target: Position): Promise<ActionResult> {
    return this.ok('look_at', { target });
  }

  async findBlock(block: string): Promise<ActionResult> {
    return { success: false, action: 'find_block', reason: `No ${block} exists in test world` };
  }

  async mineBlock(request: MineRequest): Promise<ActionResult> {
    return this.ok('mine_block', { request });
  }

  async collectResource(resource: string, amount: number): Promise<ActionResult> {
    return this.ok('collect_resource', { resource, requested: amount, collected: amount });
  }

  async pickupItems(): Promise<ActionResult> {
    return this.ok('pickup_items', { collected: 0 });
  }

  async craftItem(item: string, amount: number): Promise<ActionResult> {
    return this.ok('craft_item', { item, amount });
  }

  async equipItem(item: string): Promise<ActionResult> {
    return this.ok('equip_item', { item });
  }

  async eatBestFood(): Promise<ActionResult> {
    return this.ok('eat_best_food', { item: 'bread' });
  }

  async attackEntity(entityId: string): Promise<ActionResult> {
    return this.ok('attack_entity', { entityId });
  }

  async attackNearestHostile(): Promise<ActionResult> {
    return { success: false, action: 'attack_nearest_hostile', reason: 'No hostile in test world' };
  }

  async fleeFrom(threatId: string): Promise<ActionResult> {
    return this.ok('flee', { threatId });
  }

  async placeBlock(request: PlaceBlockRequest): Promise<ActionResult> {
    return this.ok('place_block', { request });
  }

  async sleep(): Promise<ActionResult> {
    return this.ok('sleep');
  }

  async inspectContainer(request: ContainerRequest): Promise<ActionResult> {
    return this.ok('inspect_container', { request, items: [] });
  }

  async depositItem(request: ContainerRequest): Promise<ActionResult> {
    return this.ok('deposit_item', { request });
  }

  async withdrawItem(request: ContainerRequest): Promise<ActionResult> {
    return this.ok('withdraw_item', { request });
  }

  async smeltItem(request: SmeltRequest): Promise<ActionResult> {
    return this.ok('smelt_item', { request });
  }

  async sayText(message: string): Promise<ActionResult> {
    if (message.trimStart().startsWith('/')) {
      return { success: false, action: 'say', reason: 'Commands are restricted to configured server actions' };
    }
    return this.ok('say', { message });
  }

  async executeServerCommand(command: string): Promise<ActionResult> {
    return this.ok('server_command', { command });
  }

  async speakAudio(audio: Buffer): Promise<ActionResult> {
    return this.ok('speak_audio', { bytes: audio.byteLength });
  }

  setInventory(inventory: InventoryState): void {
    this.inventory = inventory;
  }

  private emit(type: 'SERVER_CONNECTED' | 'SERVER_DISCONNECTED' | 'SPAWN'): void {
    for (const listener of this.listeners) {
      void listener({ type, serverId: this.serverId, timestamp: new Date().toISOString() });
    }
  }

  private ok(action: string, data: Record<string, unknown> = {}): ActionResult {
    return { success: true, action, finalPosition: this.position, data };
  }
}

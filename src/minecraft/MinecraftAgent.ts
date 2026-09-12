import type {
  ActionResult,
  ContainerRequest,
  InventoryState,
  MineRequest,
  MinecraftEventListener,
  MoveOptions,
  PlaceBlockRequest,
  Position,
  PlayerControlRequest,
  SmeltRequest,
  WorldState
} from './types.js';

export interface MinecraftAgent {
  readonly serverId: string;
  readonly connected: boolean;

  connect(): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  cancelCurrentAction(reason?: string): Promise<void>;
  subscribe(listener: MinecraftEventListener): () => void;

  getWorldState(): Promise<WorldState>;
  getInventory(): Promise<InventoryState>;
  moveTo(position: Position, options?: MoveOptions): Promise<ActionResult>;
  moveNear(position: Position, radius: number, options?: MoveOptions): Promise<ActionResult>;
  followPlayer(username: string): Promise<ActionResult>;
  stopFollowing(): Promise<ActionResult>;
  lookAt(target: Position): Promise<ActionResult>;
  findBlock(block: string, radius?: number): Promise<ActionResult>;
  mineBlock(request: MineRequest): Promise<ActionResult>;
  collectResource(resource: string, amount: number): Promise<ActionResult>;
  pickupItems(radius?: number): Promise<ActionResult>;
  craftItem(item: string, amount: number): Promise<ActionResult>;
  equipItem(item: string, destination?: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'): Promise<ActionResult>;
  eatBestFood(): Promise<ActionResult>;
  attackEntity(entityId: string): Promise<ActionResult>;
  attackNearestHostile(): Promise<ActionResult>;
  fleeFrom(threatId: string): Promise<ActionResult>;
  placeBlock(request: PlaceBlockRequest): Promise<ActionResult>;
  sleep(): Promise<ActionResult>;
  inspectContainer(request: ContainerRequest): Promise<ActionResult>;
  depositItem(request: ContainerRequest): Promise<ActionResult>;
  withdrawItem(request: ContainerRequest): Promise<ActionResult>;
  smeltItem(request: SmeltRequest): Promise<ActionResult>;
  sayText(message: string): Promise<ActionResult>;
  /** Transport primitive for trusted server adapters; never exposed as a model tool. */
  executeServerCommand(command: string): Promise<ActionResult>;
  speakAudio?(audio: Buffer, mimeType?: string): Promise<ActionResult>;
  voiceStatus?(): { connected: boolean; reason?: string };
  /** Client-side Fabric capabilities. Absent on autonomous Mineflayer controllers. */
  readonly supportedActions?: readonly string[];
  /** Fabric base-search primitives; never fall back to general excavating navigation. */
  scanSearchArea?(radius?: number): Promise<ActionResult>;
  baseSearchStep?(position: Position): Promise<ActionResult>;
  controlPlayer?(request: PlayerControlRequest): Promise<ActionResult>;
  controlStatus?(): { enabled: boolean; reason?: string; username?: string; worldId?: string };
}

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface InventoryItem {
  name: string;
  displayName: string;
  count: number;
  slot: number;
}

export interface InventoryState {
  items: InventoryItem[];
  freeSlots: number;
}

export interface PerceivedEntity {
  id: string;
  name: string;
  username?: string;
  uuid?: string;
  kind: 'player' | 'hostile' | 'passive' | 'item' | 'other';
  position: Position;
  distance: number;
}

export interface PerceivedBlock {
  name: string;
  position: Position;
  distance: number;
}

export interface EnvironmentalThreat {
  type: 'fire' | 'lava' | 'drowning' | 'fall' | 'hostile' | 'starvation' | 'other';
  severity: 'low' | 'medium' | 'critical';
  description: string;
  sourceId?: string;
}

export type ActionState =
  | 'IDLE'
  | 'MOVING'
  | 'FOLLOWING'
  | 'MINING'
  | 'CRAFTING'
  | 'BUILDING'
  | 'COMBAT'
  | 'FLEEING'
  | 'EATING'
  | 'SLEEPING'
  | 'INTERACTING';

export interface GoalSummary {
  id: string;
  description: string;
  priority: number;
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  scope: 'global' | 'server';
}

export interface WorldState {
  serverId: string;
  connected: boolean;
  dimension: string;
  day: number;
  time: number;
  position: Position;
  health: number;
  hunger: number;
  armor: number;
  inventory: InventoryState;
  equippedItems: InventoryItem[];
  nearbyPlayers: PerceivedEntity[];
  nearbyHostiles: PerceivedEntity[];
  nearbyPassiveMobs: PerceivedEntity[];
  nearbyUsefulBlocks: PerceivedBlock[];
  droppedItems: PerceivedEntity[];
  environmentalThreats: EnvironmentalThreat[];
  currentAction: ActionState;
  currentGoals: GoalSummary[];
  yaw?: number;
  pitch?: number;
  targetBlock?: PerceivedBlock;
}

export interface PlayerControlRequest {
  command: 'walk' | 'turn' | 'jump' | 'use' | 'attack' | 'mine_target' | 'stop';
  direction?: 'forward' | 'backward' | 'left' | 'right';
  duration_ms?: number;
  yaw?: number;
  pitch?: number;
}

export interface MoveOptions {
  timeoutMs?: number;
  sprint?: boolean;
  canDig?: boolean;
}

export interface MineRequest {
  block?: string;
  position?: Position;
}

export interface PlaceBlockRequest {
  item: string;
  position: Position;
  against?: Position;
}

export interface ContainerRequest {
  position: Position;
  item?: string;
  amount?: number;
}

export interface SmeltRequest {
  input: string;
  fuel?: string;
  amount: number;
  furnacePosition?: Position;
}

export interface ActionResult<T extends Record<string, unknown> = Record<string, unknown>> {
  success: boolean;
  action: string;
  reason?: string;
  durationMs?: number;
  finalPosition?: Position;
  data?: T;
}

export type MinecraftEventType =
  | 'SERVER_CONNECTED'
  | 'SERVER_DISCONNECTED'
  | 'SPAWN'
  | 'CHAT_MESSAGE'
  | 'PLAYER_SPOKE'
  | 'DAMAGE_TAKEN'
  | 'DEATH'
  | 'RESPAWN'
  | 'NEW_DAY'
  | 'PLAYER_APPROACHED'
  | 'PLAYER_LEFT'
  | 'VOICE_STARTED'
  | 'VOICE_STOPPED'
  | 'CONTROL_DISABLED'
  | 'ERROR';

export interface MinecraftEvent {
  type: MinecraftEventType;
  serverId: string;
  timestamp: string;
  username?: string;
  uuid?: string;
  message?: string;
  position?: Position;
  distance?: number;
  audio?: Buffer;
  audioFormat?: 'pcm_s16le_48000_mono';
  data?: Record<string, unknown>;
}

export type MinecraftEventListener = (event: MinecraftEvent) => void | Promise<void>;

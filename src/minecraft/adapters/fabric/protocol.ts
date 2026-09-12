import { z } from 'zod';

export const FABRIC_BRIDGE_PROTOCOL_VERSION = 2;
export const FABRIC_MAX_PAYLOAD_BYTES = 512 * 1024;
export const FABRIC_STATE_MAX_AGE_MS = 3000;
const text = z.string().max(512);
const identifier = z.string().min(1).max(128);
const number = z.number().finite();
export const FabricPositionSchema = z.object({ x: number, y: number, z: number });
const item = z.object({ name: text, displayName: text, count: number.int().min(0).max(1_000_000), slot: number.int().min(-1).max(1000) });
const entity = z.object({
  id: identifier, name: text, username: text.optional(), uuid: text.optional(),
  kind: z.enum(['player', 'hostile', 'passive', 'item', 'other']), position: FabricPositionSchema, distance: number.min(0)
});
const block = z.object({ name: text, position: FabricPositionSchema, distance: number.min(0) });

/** Snapshots are untrusted wire data, never blindly cast into application state. */
export const FabricWorldStateSchema = z.object({
  serverId: text, connected: z.boolean(), dimension: text,
  day: number.min(0), time: number.min(0), position: FabricPositionSchema,
  health: number.min(0), hunger: number.min(0), armor: number.min(0),
  inventory: z.object({ items: z.array(item).max(256), freeSlots: number.int().min(0).max(1000) }),
  equippedItems: z.array(item).max(16), nearbyPlayers: z.array(entity).max(512),
  nearbyHostiles: z.array(entity).max(512), nearbyPassiveMobs: z.array(entity).max(512),
  nearbyUsefulBlocks: z.array(block).max(512), droppedItems: z.array(entity).max(512),
  environmentalThreats: z.array(z.object({
    type: z.enum(['fire', 'lava', 'drowning', 'fall', 'hostile', 'starvation', 'other']),
    severity: z.enum(['low', 'medium', 'critical']), description: text, sourceId: identifier.optional()
  })).max(128),
  currentAction: z.enum(['IDLE', 'MOVING', 'FOLLOWING', 'MINING', 'CRAFTING', 'BUILDING', 'COMBAT', 'FLEEING', 'EATING', 'SLEEPING', 'INTERACTING']),
  currentGoals: z.array(z.object({ id: identifier, description: text, priority: number,
    status: z.enum(['active', 'completed', 'failed', 'abandoned']), scope: z.enum(['global', 'server']) })).max(128),
  yaw: number.optional(), pitch: number.min(-90).max(90).optional(), targetBlock: block.nullable().optional()
});
export const FabricActionResultSchema = z.object({
  success: z.boolean(), action: identifier, reason: z.string().max(4096).optional(),
  durationMs: number.min(0).optional(), finalPosition: FabricPositionSchema.optional(),
  data: z.record(z.string().max(128), z.json()).optional()
});
export const FABRIC_ACTIONS = [
  'scan_search_area', 'base_search_step',
  'move_to', 'move_near', 'follow_player', 'stop_following', 'look_at', 'find_block', 'mine_block',
  'collect_resource', 'pickup_items', 'craft_item', 'equip_item', 'eat_best_food', 'attack_entity',
  'attack_nearest_hostile', 'flee', 'place_block', 'sleep', 'inspect_container', 'deposit_item',
  'withdraw_item', 'smelt_item', 'say', 'control_player'
] as const;
export const FabricPlayerControlSchema = z.object({
  command: z.enum(['walk', 'turn', 'jump', 'use', 'attack', 'mine_target', 'stop']),
  direction: z.enum(['forward', 'backward', 'left', 'right']).optional(),
  duration_ms: number.int().min(50).max(10_000).optional(),
  yaw: number.min(-180).max(180).optional(), pitch: number.min(-90).max(90).optional()
});
/** Zero duration is an explicit continuing walk, enabled only by local configuration. */
export const FabricUnrestrictedPlayerControlSchema = FabricPlayerControlSchema.extend({
  duration_ms: number.int().min(0).max(2_147_483_647).optional()
}).refine((request) => request.duration_ms !== 0 || request.command === 'walk', 'Zero duration is only valid for continuing walks');
export const FabricBridgeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocolVersion: z.literal(FABRIC_BRIDGE_PROTOCOL_VERSION),
    username: z.string().regex(/^[A-Za-z0-9_]{1,16}$/), sessionId: identifier, worldId: z.string().min(1).max(512),
    controlsEnabled: z.boolean(), controlEpoch: number.int().min(0).max(Number.MAX_SAFE_INTEGER), supportedActions: z.array(identifier).max(64),
    capabilities: z.array(identifier).max(32).optional() }),
  z.object({ type: z.literal('state'), sessionId: identifier,
    controlEpoch: number.int().min(0).max(Number.MAX_SAFE_INTEGER), controlsEnabled: z.boolean(), state: FabricWorldStateSchema }),
  z.object({ type: z.literal('control'), sessionId: identifier,
    controlEpoch: number.int().min(0).max(Number.MAX_SAFE_INTEGER), enabled: z.boolean(), reason: text.optional() }),
  z.object({ type: z.literal('session_end'), sessionId: identifier, reason: text.optional() }),
  z.object({ type: z.literal('result'), sessionId: identifier, requestId: identifier, result: FabricActionResultSchema })
]);
export type FabricBridgeMessage = z.infer<typeof FabricBridgeMessageSchema>;

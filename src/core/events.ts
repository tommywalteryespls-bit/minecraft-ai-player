export type AgentEventType =
  | 'AUTONOMOUS_TICK'
  | 'PLAYER_SPOKE'
  | 'TOOL_FINISHED'
  | 'TOOL_FAILED'
  | 'DAMAGE_TAKEN'
  | 'LOW_HEALTH'
  | 'LOW_HUNGER'
  | 'HOSTILE_NEARBY'
  | 'PLAYER_APPROACHED'
  | 'PLAYER_LEFT'
  | 'DEATH'
  | 'RESPAWN'
  | 'NEW_DAY'
  | 'SERVER_CONNECTED'
  | 'SERVER_CHANGED'
  | 'VOICE_STARTED'
  | 'VOICE_STOPPED';

export interface AgentEvent {
  type: AgentEventType;
  serverId: string;
  timestamp: string;
  summary: string;
  data?: Record<string, unknown>;
}

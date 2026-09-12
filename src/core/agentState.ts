import type { ActionState, WorldState } from '../minecraft/types.js';

export class AgentState {
  currentAction: ActionState = 'IDLE';
  lastWorldState: WorldState | null = null;
  lastThinkAt = 0;
  lastResponseId: string | null = null;
  running = false;
  shuttingDown = false;
  currentServerId: string | null = null;

  updateWorld(state: WorldState): void {
    this.lastWorldState = state;
  }
}

import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import type { MemoryManager } from '../memory/memoryManager.js';
import type { ServerCapabilities } from '../server/serverCapabilities.js';

export class ContextBuilder {
  constructor(
    private readonly minecraft: MinecraftAgent,
    private readonly memory: MemoryManager,
    private readonly capabilities: ServerCapabilities,
    private readonly unrestricted = false
  ) {}

  async build(focus: string, username?: string): Promise<Record<string, unknown>> {
    const state = await this.minecraft.getWorldState();
    const goals = this.memory.getGoals(state.serverId);
    state.currentGoals = goals.map((goal) => ({
      id: goal.id,
      description: goal.description,
      priority: goal.priority,
      status: goal.status,
      scope: goal.scope
    }));
    return {
      identity: this.memory.getIdentity(),
      currentServer: state.serverId,
      worldState: {
        ...state,
        inventory: { ...state.inventory, items: state.inventory.items.slice(0, 50) },
        nearbyPlayers: state.nearbyPlayers.slice(0, 12),
        nearbyHostiles: state.nearbyHostiles.slice(0, 12),
        nearbyPassiveMobs: state.nearbyPassiveMobs.slice(0, 8),
        nearbyUsefulBlocks: state.nearbyUsefulBlocks.slice(0, 30),
        droppedItems: state.droppedItems.slice(0, 12)
      },
      capabilities: this.capabilities,
      clientControl: this.minecraft.controlStatus ? {
        ...this.minecraft.controlStatus(),
        // Keep local save-folder paths out of the API context; the server ID is already world-scoped.
        worldId: state.serverId,
        gameplaySkills: this.minecraft.supportedActions?.includes('craft_item') ? 'Ground A* navigation, inventory crafting/equipment, smelting and resource collection are available. Consult advertised tools for exact support.' : undefined,
        instructions: this.unrestricted
          ? 'Unrestricted task execution is enabled. No automatic task/action deadline or round cap. Continue requested steps, including open-ended tasks until interrupted; preserve explicit quantities and durations. Walking duration_ms=0 and follow_player start continuing local movement. Conservative terrain avoidance is disabled but game physics and interaction reach still apply. Never follow yourself or invent unsupported abilities. Stop releases input; a new task requires the human.'
          : 'You control the logged-in human player, not a separate bot. Complete their explicit request with the necessary supported action sequence, checking confirmed progress after each result. Individual calls may be repeated to reach the requested count; stop when done, blocked, cancelled, or at the tool-round limit. Do not add unrelated actions. Never follow yourself. control_player walk uses relative directions and bounded duration; turn uses relative yaw (positive right) and pitch (positive down). mine_target acts on the block under the crosshair. Actions are client inputs; never claim teleportation or full pathfinding. Unsupported actions must be explained honestly.'
      } : undefined,
      supportedActions: this.minecraft.supportedActions,
      relevantMemories: this.memory.retrieve(focus, state.serverId, 12),
      knownLocations: this.memory.listLocations(state.serverId, state.dimension).slice(0, 12),
      recentEvents: this.memory.recentEvents(state.serverId, 16),
      relevantPlayer: username ? this.memory.getPlayer(state.serverId, username) : null,
      recentConversation: this.memory.recentConversations(state.serverId, username, 10)
    };
  }
}

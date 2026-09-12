import type { MinecraftAgent } from '../../minecraft/MinecraftAgent.js';
import type { ServerProfile } from '../../minecraft/serverProfiles/profileTypes.js';
import type { ActionResult } from '../../minecraft/types.js';
import type { ServerFeatureAdapter } from './ServerFeatureAdapter.js';

export class ProfileCommandAdapter implements ServerFeatureAdapter {
  readonly actions: readonly string[];

  constructor(
    private readonly profile: ServerProfile,
    private readonly minecraft: MinecraftAgent
  ) {
    this.actions = Object.keys(profile.extensions?.semanticActions ?? {});
  }

  async execute(action: string, _arguments: Record<string, unknown>): Promise<ActionResult> {
    const definition = this.profile.extensions?.semanticActions[action];
    if (!definition) return { success: false, action, reason: 'Unsupported server-specific action' };
    if (definition.type === 'chat-command') return this.minecraft.executeServerCommand(definition.command);
    return { success: false, action, reason: 'Unsupported server action implementation' };
  }
}

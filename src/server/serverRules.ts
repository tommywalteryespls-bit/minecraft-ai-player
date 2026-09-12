import type { ServerProfile } from '../minecraft/serverProfiles/profileTypes.js';

export class ServerRules {
  constructor(private readonly profile: ServerProfile) {}

  assertCombatAllowed(): void {
    if (!this.profile.behavior.allowCombat) throw new Error('Combat is disabled by this server profile');
  }

  assertBreakingAllowed(): void {
    if (!this.profile.behavior.allowBlockBreaking) {
      throw new Error('Block breaking is disabled by this server profile');
    }
  }

  assertPlacementAllowed(): void {
    if (!this.profile.behavior.allowBlockPlacement) {
      throw new Error('Block placement is disabled by this server profile');
    }
  }
}

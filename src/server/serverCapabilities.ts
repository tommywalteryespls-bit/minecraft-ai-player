import type { ServerProfile } from '../minecraft/serverProfiles/profileTypes.js';

export interface ServerCapabilities {
  voiceChat: boolean;
  textChat: boolean;
  customEconomy: boolean;
  customMenus: boolean;
  semanticActions: string[];
}

export function capabilitiesFor(profile: ServerProfile): ServerCapabilities {
  return {
    ...profile.capabilities,
    semanticActions: Object.keys(profile.extensions?.semanticActions ?? {})
  };
}

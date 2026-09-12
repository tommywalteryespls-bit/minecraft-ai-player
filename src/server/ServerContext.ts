import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import type { ServerProfile } from '../minecraft/serverProfiles/profileTypes.js';
import type { ServerFeatureAdapter } from './adapters/ServerFeatureAdapter.js';
import type { ServerCapabilities } from './serverCapabilities.js';

export interface ServerContext {
  profile: ServerProfile;
  minecraft: MinecraftAgent;
  capabilities: ServerCapabilities;
  features: ServerFeatureAdapter;
}

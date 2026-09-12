import path from 'node:path';
import mineflayer, { type Bot, type BotOptions } from 'mineflayer';
import type { Logger } from 'pino';
import type { AppConfig } from '../../../config.js';
import type { ServerProfile } from '../../serverProfiles/profileTypes.js';

interface MsaCode {
  verification_uri?: string;
  verification_uri_complete?: string;
  user_code?: string;
  message?: string;
}

export function createMineflayerBot(profile: ServerProfile, config: AppConfig, logger: Logger): Bot {
  const auth = profile.auth ?? config.minecraftAuth;
  const username = config.minecraftUsername || (auth === 'offline' ? config.aiName : 'minecraft-account');
  if (auth === 'microsoft' && !config.minecraftUsername) {
    throw new Error('MC_USERNAME is required for Microsoft authentication (use the account email or a stable account identifier)');
  }
  const options: BotOptions = {
    host: profile.host,
    port: profile.port,
    username,
    auth,
    profilesFolder: path.join(config.dataDir, 'auth'),
    hideErrors: true,
    onMsaCode: (data: MsaCode) => {
      logger.info(
        {
          verificationUrl: data.verification_uri_complete ?? data.verification_uri,
          userCode: data.user_code
        },
        data.message ?? 'Microsoft device authentication is required'
      );
    }
  };
  if (profile.version !== 'auto') options.version = profile.version;
  return mineflayer.createBot(options);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';

/** Local bridge credential, separate from OpenAI. Never put it in logs or browser responses. */
export async function ensureFabricToken(config: Pick<AppConfig, 'dataDir' | 'fabricBridgeToken'>): Promise<string> {
  if (config.fabricBridgeToken) {
    if (!/^[a-f0-9]{64}$/.test(config.fabricBridgeToken)) throw new Error('FABRIC_BRIDGE_TOKEN must be 64 lowercase hexadecimal characters');
    return config.fabricBridgeToken;
  }
  const directory = path.join(config.dataDir, 'fabric');
  const file = path.join(directory, 'bridge-token.txt');
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const token = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Local Fabric pairing file is invalid; restore it or explicitly reset pairing');
  return token;
}

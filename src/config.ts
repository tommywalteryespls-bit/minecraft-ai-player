import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const optionalBooleanString = (fallback: 'true' | 'false') =>
  z.enum(['true', 'false']).default(fallback).transform((value) => value === 'true');

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime-2.1'),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-transcribe'),
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  OPENAI_VOICE: z.string().default('alloy'),
  AI_NAME: z.string().min(1).default('ChatGPT'),
  AI_OWNER: z.string().default(''),
  DEFAULT_SERVER: z.string().min(1).default('local-survival'),
  MC_USERNAME: z.string().default(''),
  MC_AUTH: z.enum(['microsoft', 'offline']).default('microsoft'),
  AUTONOMOUS_ENABLED: booleanString,
  AUTONOMOUS_THINK_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  MEMORY_ENABLED: optionalBooleanString('true'),
  VOICE_ENABLED: optionalBooleanString('true'),
  VOICE_MODE: z.enum(['minecraft', 'browser']).default('minecraft'),
  BROWSER_VOICE_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  FABRIC_BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(8765),
  FABRIC_UNRESTRICTED: optionalBooleanString('false'),
  FABRIC_BRIDGE_TOKEN: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)]).default(''),
  VOICE_TEXT_FALLBACK: optionalBooleanString('true'),
  REFLEXES_ENABLED: optionalBooleanString('true'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  TEST_MODE: optionalBooleanString('false'),
  DATA_DIR: z.string().default('./data'),
  LOG_DIR: z.string().default('./logs'),
  SERVERS_DIR: z.string().default('./servers'),
  ENTITY_SCAN_RADIUS: z.coerce.number().int().min(4).max(128).default(32),
  BLOCK_SCAN_RADIUS: z.coerce.number().int().min(4).max(64).default(24),
  PLAYER_SCAN_RADIUS: z.coerce.number().int().min(4).max(256).default(64),
  ACTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(12).default(6),
  RECONNECT_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(20).default(5),
  RECONNECT_BASE_DELAY_MS: z.coerce.number().int().min(500).default(2000),
  EXPERIMENT_MODE: z.string().default('')
});

export interface AppConfig {
  openaiApiKey: string;
  openaiModel: string;
  realtimeModel: string;
  transcribeModel: string;
  ttsModel: string;
  voice: string;
  aiName: string;
  owner: string;
  defaultServer: string;
  minecraftUsername: string;
  minecraftAuth: 'microsoft' | 'offline';
  autonomousEnabled: boolean;
  thinkIntervalMs: number;
  memoryEnabled: boolean;
  voiceEnabled: boolean;
  voiceMode?: 'minecraft' | 'browser';
  browserVoicePort?: number;
  fabricBridgePort?: number;
  fabricUnrestricted?: boolean;
  fabricBridgeToken?: string;
  voiceTextFallback: boolean;
  reflexesEnabled: boolean;
  logLevel: string;
  testMode: boolean;
  dataDir: string;
  logDir: string;
  serversDir: string;
  entityScanRadius: number;
  blockScanRadius: number;
  playerScanRadius: number;
  actionTimeoutMs: number;
  maxToolRounds: number;
  reconnectMaxAttempts: number;
  reconnectBaseDelayMs: number;
  experimentMode: string | null;
}

export function loadConfig(cwd = process.cwd()): AppConfig {
  const env = EnvSchema.parse(process.env);
  return {
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL,
    realtimeModel: env.OPENAI_REALTIME_MODEL,
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL,
    ttsModel: env.OPENAI_TTS_MODEL,
    voice: env.OPENAI_VOICE,
    aiName: env.AI_NAME,
    owner: env.AI_OWNER,
    defaultServer: env.DEFAULT_SERVER,
    minecraftUsername: env.MC_USERNAME,
    minecraftAuth: env.MC_AUTH,
    autonomousEnabled: env.AUTONOMOUS_ENABLED,
    thinkIntervalMs: env.AUTONOMOUS_THINK_INTERVAL_MS,
    memoryEnabled: env.MEMORY_ENABLED,
    voiceEnabled: env.VOICE_ENABLED,
    voiceMode: env.VOICE_MODE,
    browserVoicePort: env.BROWSER_VOICE_PORT,
    fabricBridgePort: env.FABRIC_BRIDGE_PORT,
    fabricUnrestricted: env.FABRIC_UNRESTRICTED,
    fabricBridgeToken: env.FABRIC_BRIDGE_TOKEN,
    voiceTextFallback: env.VOICE_TEXT_FALLBACK,
    reflexesEnabled: env.REFLEXES_ENABLED,
    logLevel: env.LOG_LEVEL,
    testMode: env.TEST_MODE,
    dataDir: path.resolve(cwd, env.DATA_DIR),
    logDir: path.resolve(cwd, env.LOG_DIR),
    serversDir: path.resolve(cwd, env.SERVERS_DIR),
    entityScanRadius: env.ENTITY_SCAN_RADIUS,
    blockScanRadius: env.BLOCK_SCAN_RADIUS,
    playerScanRadius: env.PLAYER_SCAN_RADIUS,
    actionTimeoutMs: env.ACTION_TIMEOUT_MS,
    maxToolRounds: env.MAX_TOOL_ROUNDS,
    reconnectMaxAttempts: env.RECONNECT_MAX_ATTEMPTS,
    reconnectBaseDelayMs: env.RECONNECT_BASE_DELAY_MS,
    experimentMode: env.EXPERIMENT_MODE || null
  };
}

export function selectedServerFromArgs(args = process.argv.slice(2)): string | undefined {
  const index = args.indexOf('--server');
  return index >= 0 ? args[index + 1] : undefined;
}

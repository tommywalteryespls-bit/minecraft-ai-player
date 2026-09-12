import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { serializeError } from './errors.js';

export type LogChannel = 'agent' | 'actions' | 'conversations' | 'errors' | 'servers';

export interface Loggers {
  agent: Logger;
  actions: Logger;
  conversations: Logger;
  errors: Logger;
  servers: Logger;
}

export function createLoggers(logDir: string, level: string): Loggers {
  fs.mkdirSync(logDir, { recursive: true });
  const redact = {
    paths: [
      'OPENAI_API_KEY',
      'openaiApiKey',
      'apiKey',
      'fabricBridgeToken',
      'FABRIC_BRIDGE_TOKEN',
      'token',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.session',
      '*.password'
    ],
    censor: '[REDACTED]'
  };
  const make = (channel: LogChannel): Logger => {
    const streams = [
      { level, stream: process.stdout },
      { level, stream: pino.destination({ dest: path.join(logDir, `${channel}.log`), sync: false }) }
    ];
    return pino({
      level,
      base: { component: channel },
      redact,
      serializers: { error: (error: unknown) => serializeError(error), err: (error: unknown) => serializeError(error) }
    }, pino.multistream(streams));
  };
  return {
    agent: make('agent'),
    actions: make('actions'),
    conversations: make('conversations'),
    errors: make('errors'),
    servers: make('servers')
  };
}

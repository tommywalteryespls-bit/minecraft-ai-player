import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, selectedServerFromArgs } from './config.js';
import { AgentApplication } from './core/application.js';
import { DeveloperConsole } from './core/developerConsole.js';
import { createLoggers } from './utils/logger.js';

export async function startApplication(ownerSignal?: AbortSignal): Promise<{ shutdown(): Promise<void>; closed: Promise<void> }> {
  const localLifetime = new AbortController();
  const signal = ownerSignal ?? localLifetime.signal;
  signal.throwIfAborted();
  const config = loadConfig();
  await Promise.all([
    fs.mkdir(config.dataDir, { recursive: true }),
    fs.mkdir(config.logDir, { recursive: true }),
    fs.mkdir(config.serversDir, { recursive: true })
  ]);
  signal.throwIfAborted();
  const loggers = createLoggers(config.logDir, config.logLevel);
  const application = new AgentApplication(config, loggers);
  let shutdownPromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let started = false;
  let developerConsole: DeveloperConsole;
  const shutdown = (reason = 'developer command'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = Promise.resolve().then(async () => {
      loggers.agent.info({ signal: reason }, 'Graceful shutdown started');
      developerConsole.close();
      try { await application.shutdown(); } finally {
        process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
        process.off('unhandledRejection', onRejection); process.off('uncaughtException', onException);
        resolveClosed();
      }
    });
    return shutdownPromise;
  };
  developerConsole = new DeveloperConsole(application, shutdown);
  // During startup, finish the in-flight stage before cleanup. Otherwise a late connect()
  // can create a listener after shutdown has already closed the database.
  const requestStop = (reason: string) => { localLifetime.abort(new Error(reason)); if (started) void shutdown(reason); };
  const onInt = () => requestStop('SIGINT');
  const onTerm = () => requestStop('SIGTERM');
  const onRejection = (error: unknown) => { loggers.errors.error({ error }, 'Unhandled promise rejection'); };
  const onException = (error: Error) => {
    loggers.errors.fatal({ error }, 'Uncaught exception');
    process.exitCode = 1; requestStop('uncaughtException');
  };
  if (!ownerSignal) { process.once('SIGINT', onInt); process.once('SIGTERM', onTerm); }
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  const serverId = selectedServerFromArgs() ?? config.defaultServer;
  loggers.agent.info(
    {
      aiName: config.aiName,
      serverId,
      testMode: config.testMode,
      autonomous: config.autonomousEnabled,
      voice: config.voiceEnabled,
      memory: config.memoryEnabled
    },
    'Starting persistent Minecraft AI'
  );
  try {
    signal.throwIfAborted(); localLifetime.signal.throwIfAborted();
    await application.startBrowserVoice();
    signal.throwIfAborted(); localLifetime.signal.throwIfAborted();
    await application.connect(serverId);
    signal.throwIfAborted(); localLifetime.signal.throwIfAborted();
    started = true;
    developerConsole.start();
    return { shutdown: () => shutdown(ownerSignal?.aborted ? 'Minecraft owner exited' : 'managed shutdown'), closed };
  } catch (error) {
    await shutdown('startup failure');
    if (!ownerSignal && localLifetime.signal.aborted && process.exitCode !== 1) return { shutdown, closed };
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void startApplication().catch((error) => {
  console.error('[FATAL]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

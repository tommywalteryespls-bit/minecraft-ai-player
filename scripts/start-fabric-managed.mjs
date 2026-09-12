// One owned Node process. Minecraft holds stdin open; no shell, build process, or detached child is created.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lifetime = new AbortController();
let deadline;
const stop = (reason) => {
  if (lifetime.signal.aborted) return;
  lifetime.abort(new Error(reason));
  // Covers slow imports/startup and misbehaving cleanup as well as a normal active backend.
  deadline = setTimeout(() => { console.error('Managed shutdown exceeded 15 seconds; exiting the owned process.'); process.exit(0); }, 15_000);
  deadline.unref();
};
const onEnd = () => stop('Minecraft owner exited');
const onError = () => stop('Minecraft ownership pipe closed');
const onInt = () => stop('SIGINT');
const onTerm = () => stop('SIGTERM');
process.stdin.once('end', onEnd);
process.stdin.once('close', onEnd);
process.stdin.once('error', onError);
process.once('SIGINT', onInt);
process.once('SIGTERM', onTerm);
process.stdin.resume();
process.chdir(root);
Object.assign(process.env, { VOICE_MODE: 'browser', AUTONOMOUS_ENABLED: 'false', REFLEXES_ENABLED: 'false',
  TEST_MODE: 'false' });
process.argv = [process.execPath, fileURLToPath(import.meta.url), '--server', 'fabric-client'];
try {
  const { runManagedBackend } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'core', 'managedLifetime.js')).href);
  await runManagedBackend({ signal: lifetime.signal,
    loadSettings: async () => {
      const { loadConfig } = await import('../dist/src/config.js');
      const { ensureFabricToken } = await import('../dist/src/utils/fabricConfig.js');
      lifetime.signal.throwIfAborted();
      const config = loadConfig(root);
      return { bridgePort: config.fabricBridgePort ?? 8765, voicePort: config.browserVoicePort ?? 3001,
        token: await ensureFabricToken(config) };
    },
    start: async (signal) => {
      const { startApplication } = await import('../dist/src/index.js');
      signal.throwIfAborted();
      return startApplication(signal);
    },
    announce: (message) => console.log(message)
  });
} catch (error) {
  if (!lifetime.signal.aborted) {
    console.error('[Managed startup failed]', error instanceof Error ? error.message : 'Unknown error');
    console.error('Run Setup Fabric Voice again if dependencies or compiled files are missing.');
    process.exitCode = 1;
  }
} finally {
  clearTimeout(deadline);
  process.stdin.off('end', onEnd); process.stdin.off('close', onEnd); process.stdin.off('error', onError);
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  process.stdin.destroy();
}

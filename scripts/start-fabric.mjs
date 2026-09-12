import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const compiler = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(compiler)) {
  console.error('Dependencies are missing. Open the project folder and run npm.cmd install once.');
  process.exitCode = 1;
} else {
  console.log('Preparing Fabric voice control…');
  const build = spawnSync(process.execPath, [compiler], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (build.error || build.status !== 0) {
    console.error('Build did not complete. No Minecraft control session was started.');
    process.exitCode = 1;
  } else {
    const child = spawn(process.execPath, [path.join(root, 'dist', 'src', 'index.js'), '--server', 'fabric-client'], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, VOICE_MODE: 'browser', AUTONOMOUS_ENABLED: 'false', REFLEXES_ENABLED: 'false', TEST_MODE: 'false' }
    });
    process.once('SIGINT', () => child.kill('SIGINT'));
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code) => { process.exitCode = code ?? 0; });
  }
}

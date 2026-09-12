// Release smoke test: only temporary instance/data directories, no Minecraft login or API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'astra-setup-verification-'));
try {
  const instance = path.join(temporary, 'Minecraft test instance');
  await fs.mkdir(instance);
  const env = { ...process.env, OPENAI_API_KEY: '', DATA_DIR: path.join(temporary, 'data'),
    DOTENV_CONFIG_PATH: path.join(temporary, 'no-env-file'), FABRIC_BRIDGE_TOKEN: '',
    FABRIC_BRIDGE_PORT: '8765', BROWSER_VOICE_PORT: '3001' };
  const install = () => run(process.execPath, [path.join(root, 'scripts', 'setup-fabric.mjs'), '--minecraft-dir', instance],
    { cwd: root, env, windowsHide: true, timeout: 60000 });
  await install();
  const mod = path.join(instance, 'mods', 'astra-voice.jar');
  const settingsFile = path.join(instance, 'config', 'astra-voice.json');
  const original = await fs.readFile(path.join(root, 'fabric-mod', 'build', 'libs', 'astra-voice-1.0.0.jar'));
  assert.deepEqual(await fs.readFile(mod), original);
  const first = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(first.token, await fs.readFile(path.join(temporary, 'data', 'fabric', 'bridge-token.txt'), 'utf8'));
  assert.equal(first.bridgePort, 8765); assert.equal(first.voicePort, 3001);
  assert.deepEqual(Object.keys(first).sort(), ['backend', 'bridgePort', 'token', 'voicePort']);
  assert.deepEqual(first.backend, { autoStart: true, projectDirectory: root, nodeExecutable: process.execPath });
  assert.ok(!JSON.stringify(first).includes('OPENAI_API_KEY'));
  await fs.writeFile(settingsFile, JSON.stringify({ ...first, customSetting: 'preserve-me', backend: {
    ...first.backend, autoStart: false, customBackendSetting: 'keep', projectDirectory: 'old-project', nodeExecutable: 'old-node'
  } }));
  await fs.writeFile(path.join(instance, 'mods', 'unrelated.fixture'), 'unrelated-mod-data');
  await install();
  const second = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(second.token, first.token); assert.equal(second.customSetting, 'preserve-me');
  assert.deepEqual(second.backend, { autoStart: false, projectDirectory: root, nodeExecutable: process.execPath, customBackendSetting: 'keep' });
  assert.ok((await fs.readdir(path.dirname(mod))).some((name) => name.startsWith('astra-voice.jar.backup-')));
  assert.ok((await fs.readdir(path.dirname(settingsFile))).some((name) => name.startsWith('astra-voice.json.backup-')));
  assert.equal(await fs.readFile(path.join(instance, 'mods', 'unrelated.fixture'), 'utf8'), 'unrelated-mod-data');
  await fs.writeFile(settingsFile, JSON.stringify({ ...second, backend: { autoStart: 'false' } }));
  await assert.rejects(install(), /backend.autoStart must be true or false/);
  assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).backend.autoStart, 'false');
  const oversized = JSON.stringify({ ...second, extra: 'x'.repeat(4096) });
  await fs.writeFile(settingsFile, oversized);
  await assert.rejects(install(), /4096-byte limit/);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), oversized);
  await fs.writeFile(settingsFile, '{broken-settings');
  await assert.rejects(install(), /could not be read/);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), '{broken-settings');
  assert.deepEqual(await fs.readFile(mod), original);
  console.log('PASS: installable JAR copied, pairing reused, automatic-start paths installed, opt-out/custom settings preserved, backups created, malformed settings not overwritten.');
  console.log('No live Minecraft directory or OpenAI API was used.');
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('astra-setup-verification-'));
  await fs.rm(resolved, { recursive: true, force: true });
}

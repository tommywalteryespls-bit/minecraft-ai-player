import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
try {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== '--minecraft-dir' || args.length !== 2)) throw new Error('Usage: node scripts/setup-fabric.mjs [--minecraft-dir "C:\\path\\to\\your\\Minecraft\\instance"]');
  const gameDir = path.resolve(args[1] ?? path.join(process.env.APPDATA ?? '', '.minecraft'));
  if (!args[1] && !process.env.APPDATA) throw new Error('Choose your instance with --minecraft-dir');
  const stat = await fs.stat(gameDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Minecraft instance directory does not exist: ${gameDir}`);
  const jar = path.join(root, 'fabric-mod', 'build', 'libs', 'astra-voice-1.0.0.jar');
  if (!(await fs.stat(jar).catch(() => null))?.isFile()) throw new Error('The Fabric mod jar is missing. Build fabric-mod first; see docs/fabric-voice.md.');
  const compiler = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const build = spawnSync(process.execPath, [compiler], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (build.error || build.status !== 0) throw new Error('Backend build failed; nothing was installed.');
  const { loadConfig } = await import('../dist/src/config.js');
  const { ensureFabricToken } = await import('../dist/src/utils/fabricConfig.js');
  const config = loadConfig(root);
  const token = await ensureFabricToken(config);
  const mods = path.join(gameDir, 'mods'), configDir = path.join(gameDir, 'config');
  // These are fixed children of an explicitly selected, existing instance; never follow a computed broad target.
  for (const directory of [mods, configDir]) {
    const relative = path.relative(gameDir, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid instance target');
    if ((await fs.lstat(directory).catch(() => null))?.isSymbolicLink()) throw new Error(`Refusing linked installation directory: ${directory}. Select a normal Minecraft instance directory.`);
    await fs.mkdir(directory, { recursive: true });
  }
  const destination = path.join(mods, 'astra-voice.jar');
  const settingsFile = path.join(configDir, 'astra-voice.json');
  for (const target of [destination, settingsFile]) {
    if ((await fs.lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error(`Refusing to overwrite linked file: ${target}`);
  }
  const duplicates = (await fs.readdir(mods)).filter((name) => /^astra[-_]voice.*\.jar$/i.test(name) && name !== 'astra-voice.jar');
  if (duplicates.length) throw new Error(`Another Astra JAR is present: ${duplicates.join(', ')}. Move it outside the mods folder first to avoid duplicate mod IDs.`);
  const backupSuffix = `.backup-${Date.now()}`;
  let settings = {};
  try { settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Existing astra-voice.json could not be read; it was not overwritten.'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Existing mod settings are invalid; nothing was overwritten.');
  if (settings.backend !== undefined && (!settings.backend || typeof settings.backend !== 'object' || Array.isArray(settings.backend))) {
    throw new Error('Existing backend settings are invalid; nothing was overwritten.');
  }
  if (settings.backend?.autoStart !== undefined && typeof settings.backend.autoStart !== 'boolean') {
    throw new Error('Existing backend.autoStart must be true or false; nothing was overwritten.');
  }
  const backend = {
    ...settings.backend,
    autoStart: settings.backend?.autoStart ?? true,
    projectDirectory: root,
    nodeExecutable: process.execPath
  };
  const settingsText = JSON.stringify({ ...settings, token, bridgePort: config.fabricBridgePort ?? 8765,
    voicePort: config.browserVoicePort ?? 3001, backend }, null, 2) + '\n';
  if (Buffer.byteLength(settingsText, 'utf8') > 4096) {
    throw new Error('Updated voice config exceeds the mod\'s 4096-byte limit; nothing was overwritten. Reduce custom settings first.');
  }
  for (const target of [destination, settingsFile]) {
    if (await fs.stat(target).catch(() => null)) {
      await fs.copyFile(target, target + backupSuffix);
      console.log(`Backed up existing file: ${target + backupSuffix}`);
    }
  }
  await fs.copyFile(jar, destination);
  await fs.writeFile(settingsFile, settingsText, { mode: 0o600 });
  console.log(`Installed: ${destination}`);
  console.log('Paired the mod with this project. Your OpenAI API key was NOT copied into Minecraft.');
  console.log('Use Fabric for Minecraft 1.21.11 with Fabric API for 1.21.11.');
  console.log(backend.autoStart
    ? 'Automatic backend startup enabled: launch Minecraft normally. No need to run Start Fabric Voice.cmd.'
    : 'Automatic backend startup is disabled in your existing config. Start Fabric Voice.cmd is still available.');
  console.log('Join a permitted world/server and open the voice panel with /astra voice or a browser bookmark.');
  console.log('Click Start hands-free in the browser, allow the microphone, return to Minecraft, close menus, then press F8. F9 is emergency stop.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

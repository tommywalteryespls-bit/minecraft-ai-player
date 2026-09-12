import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { reserveManagedPorts, runManagedBackend, takeManagedServer } from '../src/core/managedLifetime.js';

const token = 'ab'.repeat(32);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}
async function freePorts(): Promise<{ bridgePort: number; voicePort: number; token: string }> {
  const a = createServer(), b = createServer();
  const bridgePort = await listen(a), voicePort = await listen(b);
  await Promise.all([close(a), close(b)]);
  return { bridgePort, voicePort, token };
}
async function assertFree(port: number): Promise<void> { const server = createServer(); await listen(server, port); await close(server); }
function health(port: number, supplied = token): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/astra/health', agent: false, headers: { Authorization: `Bearer ${supplied}` } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (part: string) => { body += part; }); res.on('end', () => resolve({ status: res.statusCode!, body: body ? JSON.parse(body) : {} }));
    }); req.on('error', reject); req.end();
  });
}
async function waitFor(check: () => Promise<boolean> | boolean, message: () => string = () => 'Timed out', ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(message()); await delay(25); }
}

test('managed ports are an authenticated OS-owned lock with no stale files; already-ready backend is reused', async (t) => {
  const settings = await freePorts();
  const owner = await reserveManagedPorts(settings, new AbortController().signal); assert.ok(owner);
  t.after(() => owner.close());
  assert.equal((await health(settings.bridgePort)).body.ready, false);
  assert.equal((await health(settings.bridgePort, 'cd'.repeat(32))).status, 403);
  owner.ready = true;
  let started = false;
  assert.equal(await runManagedBackend({ signal: new AbortController().signal, loadSettings: async () => settings,
    start: async () => { started = true; throw new Error('Must not start'); } }), 'reused');
  assert.equal(started, false);
  assert.equal(owner.bridge.listening, true, 'reuse must not close another owner');
});

test('concurrent reservation losers wait for the winner without touching its sockets', async (t) => {
  const settings = await freePorts();
  const first = await reserveManagedPorts(settings, new AbortController().signal); assert.ok(first);
  t.after(() => first.close());
  const second = reserveManagedPorts(settings, new AbortController().signal, 1500);
  await delay(130); first.ready = true;
  assert.equal(await second, null);
  assert.equal(first.bridge.listening, true);
});

test('unrelated or differently paired bridge is never reused, killed, or imported into the app', async (t) => {
  const settings = await freePorts();
  const unrelated = createServer((_req, res) => { res.end('{}'); });
  await listen(unrelated, settings.bridgePort); t.after(() => close(unrelated));
  await assert.rejects(reserveManagedPorts(settings, new AbortController().signal), /incompatible|differently paired/);
  assert.equal(unrelated.listening, true);
  await assertFree(settings.voicePort);
});

test('voice port conflict releases only this launchers bridge reservation', async (t) => {
  const settings = await freePorts();
  const unrelated = createServer((_req, res) => res.end('other application'));
  await listen(unrelated, settings.voicePort); t.after(() => close(unrelated));
  await assert.rejects(reserveManagedPorts(settings, new AbortController().signal), /EADDRINUSE/);
  assert.equal(unrelated.listening, true);
  await assertFree(settings.bridgePort);
});

test('EOF during slow startup waits for the stage to settle, then shuts down adopted and unclaimed sockets', async () => {
  const settings = await freePorts(), owner = new AbortController();
  const entered = deferred<void>(), continueStartup = deferred<void>();
  let shutdowns = 0;
  const run = runManagedBackend({ signal: owner.signal, loadSettings: async () => settings, start: async () => {
    const bridge = takeManagedServer('bridge', settings.bridgePort); assert.ok(bridge?.listening);
    assert.equal(takeManagedServer('bridge', settings.bridgePort), undefined, 'a reservation is handed off once');
    entered.resolve(); await continueStartup.promise;
    return { closed: new Promise<void>(() => {}), shutdown: async () => { shutdowns++; await close(bridge); } };
  } });
  await entered.promise; owner.abort(); await delay(20);
  assert.equal(shutdowns, 0, 'cleanup must not run before startup finishes allocating');
  continueStartup.resolve(); assert.equal(await run, 'stopped'); assert.equal(shutdowns, 1);
  await assertFree(settings.bridgePort); await assertFree(settings.voicePort);
});

test('failed startup and internally closed app both release ownership without waiting for Minecraft EOF', async () => {
  const settings = await freePorts();
  await assert.rejects(runManagedBackend({ signal: new AbortController().signal, loadSettings: async () => settings,
    start: async () => { throw new Error('fake startup failure'); } }), /fake startup failure/);
  await assertFree(settings.bridgePort); await assertFree(settings.voicePort);
  let shutdowns = 0;
  assert.equal(await runManagedBackend({ signal: new AbortController().signal, loadSettings: async () => settings,
    start: async () => ({ closed: Promise.resolve(), shutdown: async () => { shutdowns++; } }) }), 'stopped');
  assert.equal(shutdowns, 1); await assertFree(settings.bridgePort); await assertFree(settings.voicePort);
});

test('waiting for another startup is bounded and cancellation leaves its owner untouched', async (t) => {
  const settings = await freePorts();
  const first = await reserveManagedPorts(settings, new AbortController().signal); assert.ok(first);
  t.after(() => first.close());
  await assert.rejects(reserveManagedPorts(settings, new AbortController().signal, 50), /did not become ready/);
  const abort = new AbortController(); const waiting = reserveManagedPorts(settings, abort.signal);
  abort.abort(); await assert.rejects(waiting); assert.equal(first.bridge.listening, true);
});

type ChildFixture = { child: ChildProcessWithoutNullStreams; output(): string; exited: Promise<number | null> };
async function environment(t: TestContext, profile = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'astra-managed-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('astra-managed-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, 'servers'));
  if (profile) await fs.writeFile(path.join(directory, 'servers', 'fabric.json'), JSON.stringify({ id: 'fabric-client', name: 'Isolated test Fabric',
    host: 'unused', controller: 'fabric', behavior: { autonomous: false }, reconnect: { enabled: false, maxAttempts: 0 } }));
  const dotenv = path.join(directory, 'isolated.env'); await fs.writeFile(dotenv, '');
  const settings = await freePorts();
  return { directory, settings, env: { ...process.env, DOTENV_CONFIG_PATH: dotenv, OPENAI_API_KEY: '', DATA_DIR: path.join(directory, 'data'),
    LOG_DIR: path.join(directory, 'logs'), SERVERS_DIR: path.join(directory, 'servers'), FABRIC_BRIDGE_TOKEN: token,
    FABRIC_BRIDGE_PORT: String(settings.bridgePort), BROWSER_VOICE_PORT: String(settings.voicePort), LOG_LEVEL: 'info' } };
}
function launch(t: TestContext, env: NodeJS.ProcessEnv, script = path.join(root, 'scripts', 'start-fabric-managed.mjs')): ChildFixture {
  const child = spawn(process.execPath, [script], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)); });
  void exited.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const done = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
      if (!done) { child.kill('SIGKILL'); await exited; }
    }
  });
  return { child, output: () => output, exited };
}
async function ready(f: ChildFixture, port: number): Promise<void> {
  await waitFor(async () => {
    if (f.child.exitCode !== null) throw new Error(`Backend exited before ready: ${f.output()}`);
    try { return (await health(port)).body.ready === true; } catch { return false; }
  }, f.output);
}

test('real managed launcher starts exactly one app, reuses it without SQLite startup, and EOF closes both ports', { timeout: 30_000 }, async (t) => {
  const e = await environment(t), first = launch(t, e.env);
  await ready(first, e.settings.bridgePort);
  assert.equal((first.output().match(/Starting persistent Minecraft AI/g) ?? []).length, 1, first.output());
  assert.match(first.output(), /"autonomous":false/);
  const panel = await fetch(`http://127.0.0.1:${e.settings.voicePort}/api/session`);
  assert.equal(panel.status, 200); assert.equal((await panel.json() as { controller: string }).controller, 'fabric');
  const second = launch(t, e.env);
  assert.equal(await second.exited, 0, second.output()); assert.match(second.output(), /Existing paired Fabric backend reused/);
  assert.doesNotMatch(second.output(), /Starting persistent Minecraft AI/);
  assert.equal((await health(e.settings.bridgePort)).body.ready, true, 'reuse must preserve original backend');
  first.child.stdin.end(); assert.equal(await first.exited, 0, first.output());
  assert.match(first.output(), /Shutdown complete/);
  await assertFree(e.settings.bridgePort); await assertFree(e.settings.voicePort);
});

test('real managed launcher observes immediate owner EOF before app startup', { timeout: 15_000 }, async (t) => {
  const e = await environment(t), f = launch(t, e.env); f.child.stdin.end();
  assert.equal(await f.exited, 0, f.output());
  assert.doesNotMatch(f.output(), /Starting persistent Minecraft AI/);
  await assertFree(e.settings.bridgePort); await assertFree(e.settings.voicePort);
});

test('real startup failure closes partial browser and database resources and exits nonzero', { timeout: 30_000 }, async (t) => {
  const e = await environment(t, false), f = launch(t, e.env);
  assert.equal(await f.exited, 1, f.output()); assert.match(f.output(), /Managed startup failed/); assert.match(f.output(), /Shutdown complete/);
  await assertFree(e.settings.bridgePort); await assertFree(e.settings.voicePort);
  // A fresh launcher using the same memory and ports can start after the failure.
  await fs.writeFile(path.join(e.directory, 'servers', 'fabric.json'), JSON.stringify({ id: 'fabric-client', name: 'Retry', host: 'unused', controller: 'fabric' }));
  const retry = launch(t, e.env); await ready(retry, e.settings.bridgePort); retry.child.stdin.end(); assert.equal(await retry.exited, 0, retry.output());
});

test('simultaneous real launchers start one app; process death leaves no stale startup lock', { timeout: 40_000 }, async (t) => {
  const e = await environment(t), first = launch(t, e.env), second = launch(t, e.env);
  await waitFor(async () => { try { return (await health(e.settings.bridgePort)).body.ready === true; } catch { return false; } }, () => first.output() + second.output());
  const loser = await Promise.race([first.exited.then((code) => ({ fixture: first, code })), second.exited.then((code) => ({ fixture: second, code }))]);
  assert.equal(loser.code, 0, loser.fixture.output()); assert.match(loser.fixture.output(), /reused/);
  const owner = loser.fixture === first ? second : first;
  assert.equal((first.output().match(/Starting persistent Minecraft AI/g) ?? []).length + (second.output().match(/Starting persistent Minecraft AI/g) ?? []).length, 1);
  owner.child.kill('SIGKILL'); await owner.exited;
  const retry = launch(t, e.env); await ready(retry, e.settings.bridgePort); retry.child.stdin.end(); assert.equal(await retry.exited, 0, retry.output());
});

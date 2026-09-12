import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Server } from 'node:http';
import pino from 'pino';
import type { AppConfig } from '../src/config.js';
import { AgentApplication } from '../src/core/application.js';
import type { OpenAIService } from '../src/ai/openai.js';
import { ServerProfileSchema } from '../src/minecraft/serverProfiles/profileTypes.js';
import { ensureFabricToken } from '../src/utils/fabricConfig.js';

async function temporaryDirectory(t: TestContext, beforeCleanup?: () => Promise<void>): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'astra-fabric-workflow-'));
  t.after(async () => {
    await beforeCleanup?.();
    // Validate the exact test-owned target before recursive cleanup on Windows.
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('astra-fabric-workflow-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('Fabric pairing generates one persistent credential and reuses it without rewriting', async (t) => {
  const directory = await temporaryDirectory(t);
  const config = { dataDir: directory };
  const first = await ensureFabricToken(config);
  assert.match(first, /^[a-f0-9]{64}$/);
  const file = path.join(directory, 'fabric', 'bridge-token.txt');
  const original = await fs.readFile(file, 'utf8');
  const second = await ensureFabricToken(config);
  assert.equal(second, first);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  // A normal final newline in a restored pairing file is tolerated without rewriting it.
  await fs.writeFile(file, first + '\n');
  assert.equal(await ensureFabricToken(config), first);
  assert.equal(await fs.readFile(file, 'utf8'), first + '\n');
});

test('Fabric pairing refuses damaged credentials without replacing the existing file', async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.mkdir(path.join(directory, 'fabric'));
  const file = path.join(directory, 'fabric', 'bridge-token.txt');
  const original = 'invalid-existing-pairing-do-not-overwrite';
  await fs.writeFile(file, original);
  await assert.rejects(ensureFabricToken({ dataDir: directory }), /pairing file is invalid/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await assert.rejects(ensureFabricToken({ dataDir: directory, fabricBridgeToken: 'invalid-env-value' }), /64 lowercase hexadecimal/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('Fabric explicit pairing credentials do not create or overwrite disk pairing data', async (t) => {
  const directory = await temporaryDirectory(t);
  const credential = '42'.repeat(32);
  assert.equal(await ensureFabricToken({ dataDir: directory, fabricBridgeToken: credential }), credential);
  await assert.rejects(fs.stat(path.join(directory, 'fabric')), { code: 'ENOENT' });
  await assert.rejects(ensureFabricToken({ dataDir: directory, fabricBridgeToken: 'AB'.repeat(32) }), /lowercase/);
  assert.deepEqual(await fs.readdir(directory), []);
});

async function applicationFixture(t: TestContext) {
  let app: AgentApplication | undefined;
  const directory = await temporaryDirectory(t, async () => { await app?.shutdown(); });
  const config: AppConfig = {
    openaiApiKey: 'unit-test-key-never-used', openaiModel: 'test-planner', realtimeModel: 'test-realtime',
    transcribeModel: 'test-transcription', ttsModel: 'test-tts', voice: 'onyx', aiName: 'Astra', owner: 'TestPlayer',
    defaultServer: 'fabric-workflow', minecraftUsername: 'Unused', minecraftAuth: 'offline',
    autonomousEnabled: true, thinkIntervalMs: 20, memoryEnabled: true, voiceEnabled: true,
    voiceMode: 'minecraft', browserVoicePort: 0, fabricBridgePort: 0,
    voiceTextFallback: true,
    reflexesEnabled: true, logLevel: 'silent', testMode: false,
    dataDir: path.join(directory, 'data'), logDir: path.join(directory, 'logs'), serversDir: path.join(directory, 'servers'),
    entityScanRadius: 32, blockScanRadius: 24, playerScanRadius: 64, actionTimeoutMs: 1000, maxToolRounds: 2,
    reconnectMaxAttempts: 1, reconnectBaseDelayMs: 500, experimentMode: null
  };
  // Deliberately immutable: selecting Fabric must not alter settings used by later controllers.
  Object.freeze(config);
  const logger = pino({ level: 'silent' });
  app = new AgentApplication(config, { agent: logger, actions: logger, conversations: logger, errors: logger, servers: logger });
  t.mock.method(app.profiles, 'load', async (id: string) => ServerProfileSchema.parse({
    id, name: 'Fabric test profile', host: 'not-contacted.invalid', controller: 'fabric', behavior: { autonomous: true }
  }));
  const api = (app as unknown as { openai: OpenAIService }).openai;
  let apiCalls = 0;
  t.mock.method(api, 'requireClient', () => { apiCalls++; throw new Error('No API call is permitted in this workflow test'); });
  return { app, config, directory, apiCalls: () => apiCalls };
}

test('Fabric application waits safely for Minecraft and starts browser voice without mutating original config', async (t) => {
  const f = await applicationFixture(t);
  await f.app.connect('fabric-workflow');
  assert.equal(f.config.voiceMode, 'minecraft');
  assert.equal(f.app.activeVoiceMode, 'browser');
  assert.equal(f.config.autonomousEnabled, true);
  assert.equal(f.config.reflexesEnabled, true);
  assert.equal(f.app.currentServerId, 'fabric-workflow');
  const status = await f.app.state();
  assert.equal(status.running, true); assert.equal(status.connected, false); assert.equal(status.autonomous, false);
  assert.equal(status.world, null);
  assert.equal(f.app.currentAgent?.voiceStatus().transcriptionTransport, 'file');
  assert.ok(f.app.currentAgent);
  await assert.rejects(f.app.currentAgent.thinkNow(), /explicit voice command/);
  assert.throws(() => f.app.currentAgent!.setAutonomy(true), /command-only/);
  const internals = f.app.currentAgent as unknown as { config: AppConfig; voice: { config: AppConfig }; reflexes: { timer: unknown } };
  assert.equal(internals.config.voiceMode, 'browser');
  assert.equal(internals.voice.config.voiceMode, 'browser');
  assert.equal(internals.reflexes.timer, null, 'Fabric never starts automatic reflex controls');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.apiCalls(), 0);
  assert.match(await fs.readFile(path.join(f.config.dataDir, 'fabric', 'bridge-token.txt'), 'utf8'), /^[a-f0-9]{64}$/);
});

test('Fabric browser status is authenticated, hides pairing credentials, and rejects speech before connection without API usage', async (t) => {
  const f = await applicationFixture(t);
  await f.app.connect('fabric-workflow');
  const url = f.app.browserVoiceUrl;
  assert.ok(url && /^http:\/\/127\.0\.0\.1:\d+$/.test(url));
  const sessionResponse = await fetch(url + '/api/session');
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as Record<string, unknown>;
  assert.match(String(session.token), /^[a-f0-9]{64}$/);
  assert.equal(session.controller, 'fabric'); assert.equal(session.owner, 'TestPlayer');
  assert.equal(session.connected, false); assert.equal(session.controlEnabled, false); assert.equal(session.enabled, true);
  const pairing = await fs.readFile(path.join(f.config.dataDir, 'fabric', 'bridge-token.txt'), 'utf8');
  assert.notEqual(session.token, pairing);
  assert.ok(!JSON.stringify(session).includes(pairing));
  assert.ok(!JSON.stringify(session).includes(f.config.openaiApiKey));
  assert.equal((await fetch(url + '/api/status')).status, 403);
  assert.equal((await fetch(url + '/api/session', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  const headers = { Origin: url, 'X-Voice-Token': String(session.token), 'Content-Type': 'application/octet-stream' };
  const status = await fetch(url + '/api/status', { headers });
  assert.equal(status.status, 200); assert.equal((await status.json() as Record<string, unknown>).connected, false);
  const speech = await fetch(url + '/api/voice', { method: 'POST', headers, body: Buffer.alloc(9600) });
  const result = await speech.json() as Record<string, unknown>;
  assert.equal(result.success, false); assert.equal(result.stage, 'availability');
  assert.equal(f.apiCalls(), 0);
  const bridgeServer = (f.app as unknown as { minecraft: { server: Server } }).minecraft.server;
  assert.equal(bridgeServer.listening, true);
  await f.app.shutdown();
  assert.equal(bridgeServer.listening, false);
  assert.equal(f.app.browserVoiceUrl, null); assert.equal(f.app.currentAgent, null);
  assert.equal(f.config.voiceMode, 'minecraft');
  await assert.rejects(fetch(url + '/api/session'), /fetch failed/);
  await f.app.shutdown();
  assert.equal(f.apiCalls(), 0);
});

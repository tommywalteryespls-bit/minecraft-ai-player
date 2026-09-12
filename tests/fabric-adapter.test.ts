import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import pino from 'pino';
import type { AppConfig } from '../src/config.js';
import type { MinecraftEvent, WorldState } from '../src/minecraft/types.js';
import { ServerProfileSchema } from '../src/minecraft/serverProfiles/profileTypes.js';
import { FabricAdapter } from '../src/minecraft/adapters/fabric/FabricAdapter.js';
import { FabricBridgeMessageSchema } from '../src/minecraft/adapters/fabric/protocol.js';

const token = '9a'.repeat(32);
function state(): WorldState {
  return { serverId: 'untrusted-id', connected: true, dimension: 'minecraft:overworld', day: 1, time: 100,
    position: { x: 1, y: 64, z: 2 }, yaw: 30, pitch: 0,
    targetBlock: { name: 'stone', position: { x: 1, y: 63, z: 2 }, distance: 1 },
    health: 20, hunger: 20, armor: 0, inventory: { items: [], freeSlots: 36 }, equippedItems: [],
    nearbyPlayers: [], nearbyHostiles: [], nearbyPassiveMobs: [], nearbyUsefulBlocks: [], droppedItems: [],
    environmentalThreats: [], currentAction: 'IDLE', currentGoals: [] };
}
async function waitFor(check: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Test condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t: TestContext, supportedActions = ['control_player', 'follow_player', 'stop_following', 'move_to', 'say'], armed = true,
  configuration: Partial<AppConfig> = {}, capabilities: string[] = [], behavior: Record<string, boolean> = {}) {
  const profile = ServerProfileSchema.parse({ id: 'fabric-test', name: 'Fabric', host: 'unused', controller: 'fabric', behavior });
  const adapter = new FabricAdapter(profile, { fabricBridgePort: 0, fabricBridgeToken: token, actionTimeoutMs: 2000, ...configuration } as AppConfig, pino({ level: 'silent' }));
  await adapter.connect();
  t.after(() => adapter.disconnect());
  const address = (adapter as unknown as { server: Server }).server.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}/astra`;
  const messages: Array<Record<string, any>> = [];
  const events: MinecraftEvent[] = [];
  adapter.subscribe((event) => { events.push(event); });
  const client = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  client.on('message', (data) => messages.push(JSON.parse(data.toString()) as Record<string, any>));
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  t.after(() => client.terminate());
  const send = (message: unknown) => client.send(JSON.stringify(message));
  const hello = (sessionId = 'session-1', worldId = 'private/world1', enabled = armed, controlEpoch = 1) => send({ type: 'hello', protocolVersion: 2,
    username: 'TestPlayer', sessionId, worldId, controlsEnabled: enabled, controlEpoch, supportedActions, capabilities });
  const snapshot = (sessionId = 'session-1', controlEpoch = 1, enabled = armed) => send({ type: 'state', sessionId, controlEpoch, controlsEnabled: enabled, state: state() });
  hello(); snapshot();
  await waitFor(() => adapter.connected);
  return { adapter, client, url, messages, events, send, hello, snapshot, profile };
}

test('Fabric handshake validates world snapshots, preserves view data, and scopes memory by world', async (t) => {
  const f = await fixture(t, undefined, false);
  assert.equal(f.adapter.controlStatus().enabled, false);
  assert.equal(f.adapter.controlStatus().username, 'TestPlayer');
  const snapshot = await f.adapter.getWorldState();
  assert.match(snapshot.serverId, /^fabric-test-[0-9a-f]{12}$/);
  assert.equal(snapshot.yaw, 30); assert.equal(snapshot.targetBlock?.name, 'stone');
  snapshot.position.x = 123;
  assert.equal((await f.adapter.getWorldState()).position.x, 1, 'callers cannot mutate cached state');
  assert.equal(f.events.filter((event) => event.type === 'SERVER_CONNECTED').length, 1);
  await f.adapter.connect();
  assert.equal(f.adapter.connected, true, 'connect is idempotent');
  const disarmed = await f.adapter.followPlayer('Friend');
  assert.equal(disarmed.success, false); assert.match(disarmed.reason!, /disarmed/);
  const oldId = f.adapter.serverId;
  f.send({ type: 'session_end', sessionId: 'session-1', reason: 'World changed' });
  await waitFor(() => !f.adapter.connected);
  assert.equal(f.events.at(-1)?.serverId, oldId);
  assert.equal(f.events.at(-1)?.data?.intentional, true);
  f.hello('session-2', 'private/world2'); f.snapshot('session-2');
  await waitFor(() => f.adapter.connected);
  assert.notEqual(f.adapter.serverId, oldId);
});

test('Fabric authenticated health probes do not replace or modify an active Minecraft session', async (t) => {
  const f = await fixture(t, undefined, true, { browserVoicePort: 3456 });
  const before = await f.adapter.getWorldState();
  const url = new URL(f.url.replace('ws:', 'http:') + '/health');
  const probe = (headers: Record<string, string>, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(url, { method, headers, agent: false }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (part: string) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    }); req.on('error', reject); req.end();
  });
  const success = await probe({ Authorization: `Bearer ${token}` });
  assert.equal(success.status, 200);
  assert.deepEqual(JSON.parse(success.body), { app: 'astra-fabric-backend', protocolVersion: 2, voicePort: 3456, ready: true });
  for (const headers of [{}, { Authorization: `Bearer ${'00'.repeat(32)}` },
    { Authorization: `Bearer ${token}`, Origin: 'http://127.0.0.1:3456' }, { Authorization: `Bearer ${token}`, Host: 'evil.example' }]) {
    assert.equal((await probe(headers as Record<string, string>)).status, 403);
  }
  assert.equal((await probe({ Authorization: `Bearer ${token}` }, 'POST')).status, 403);
  assert.equal(f.client.readyState, WebSocket.OPEN);
  assert.equal(f.adapter.controlStatus().enabled, true);
  assert.deepEqual(await f.adapter.getWorldState(), before);
});

test('Fabric listener rejects wrong token, Host, Origin, route, and a second client', async (t) => {
  const f = await fixture(t);
  const reject = (url: string, headers: Record<string, string>) => new Promise<void>((resolve, reject) => {
    const client = new WebSocket(url, { headers });
    client.once('open', () => { client.terminate(); reject(new Error('Unauthorized socket opened')); });
    client.once('error', (error) => { assert.match(error.message, /403/); resolve(); });
  });
  await reject(f.url, { Authorization: `Bearer ${token}` });
  f.client.terminate(); await waitFor(() => !f.adapter.connected);
  await reject(f.url, { Authorization: `Bearer ${'00'.repeat(32)}` });
  await reject(f.url, { Authorization: `Bearer ${token}`, Origin: 'http://127.0.0.1:3001' });
  await reject(f.url, { Authorization: `Bearer ${token}`, Host: 'evil.example' });
  await reject(f.url.replace('/astra', '/other'), { Authorization: `Bearer ${token}` });
  await reject(f.url, {});
});

test('Fabric actions have bounded requests and only matching session results resolve them', async (t) => {
  const f = await fixture(t);
  const action = f.adapter.moveTo({ x: 4, y: 64, z: 2 }, { timeoutMs: 1000, canDig: false });
  await waitFor(() => f.messages.some((message) => message.type === 'action'));
  const message = f.messages.find((message) => message.type === 'action')!;
  assert.equal(message.sessionId, 'session-1'); assert.equal(message.controlEpoch, 1);
  assert.equal(message.arguments.can_dig, false); assert.equal(message.timeoutMs, 1000);
  let resolved = false; void action.then(() => { resolved = true; });
  f.send({ type: 'result', sessionId: 'old-session', requestId: message.requestId, result: { success: true, action: 'move_to' } });
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(resolved, false);
  f.send({ type: 'result', sessionId: 'session-1', requestId: message.requestId, result: { success: true, action: 'spoofed_name', finalPosition: { x: 4, y: 64, z: 2 } } });
  assert.deepEqual(await action, { success: true, action: 'move_to', finalPosition: { x: 4, y: 64, z: 2 } });
});

test('Fabric disarm cancels pending work, rejects stale epochs, and still accepts stop', async (t) => {
  const f = await fixture(t);
  const pending = f.adapter.followPlayer('Friend');
  await waitFor(() => f.messages.some((message) => message.type === 'action'));
  f.send({ type: 'control', sessionId: 'session-1', controlEpoch: 2, enabled: false, reason: 'Emergency stop key' });
  assert.equal((await pending).success, false);
  await waitFor(() => f.events.some((event) => event.type === 'CONTROL_DISABLED'));
  assert.equal(f.adapter.connected, true); assert.equal(f.adapter.controlStatus().enabled, false);
  f.snapshot('session-1', 1, true);
  f.send({ type: 'control', sessionId: 'session-1', controlEpoch: 1, enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.adapter.controlStatus().enabled, false);
  assert.equal((await f.adapter.controlPlayer({ command: 'walk', duration_ms: 100 })).success, false);
  const stop = f.adapter.controlPlayer({ command: 'stop' });
  await waitFor(() => f.messages.some((message) => message.type === 'action' && message.arguments.command === 'stop'));
  const message = f.messages.find((message) => message.type === 'action' && message.arguments.command === 'stop')!;
  assert.equal(message.controlEpoch, 2);
  f.send({ type: 'result', sessionId: 'session-1', requestId: message.requestId, result: { success: true, action: 'control_player' } });
  assert.equal((await stop).success, true);
});

test('Fabric cancellation and timeout send cancellation messages and release all requests', async (t) => {
  const f = await fixture(t);
  const first = f.adapter.followPlayer('Friend');
  await f.adapter.cancelCurrentAction('User cancelled');
  assert.match((await first).reason!, /User cancelled/);
  const second = f.adapter.moveTo({ x: 2, y: 64, z: 2 }, { timeoutMs: 100 });
  assert.match((await second).reason!, /timed out/);
  await waitFor(() => f.messages.some((message) => message.type === 'cancel' && message.requestId));
  assert.ok(f.messages.some((message) => message.type === 'cancel' && message.reason === 'User cancelled'));
});

test('Fabric unsupported capabilities, unsafe chat, and invalid control arguments never dispatch', async (t) => {
  const f = await fixture(t, ['control_player', 'say', 'execute_shell']);
  assert.deepEqual(f.adapter.supportedActions, ['control_player', 'say']);
  assert.match((await f.adapter.craftItem('diamond', 1)).reason!, /does not support craft_item/);
  assert.equal((await f.adapter.executeServerCommand('/op Friend')).success, false);
  assert.equal((await f.adapter.sayText('/op Friend')).success, false);
  assert.equal((await f.adapter.sayText('hello\n/op Friend')).success, false);
  assert.equal((await f.adapter.controlPlayer({ command: 'walk', duration_ms: 100_000 })).success, false);
  f.profile.behavior.allowCombat = false;
  assert.equal((await f.adapter.controlPlayer({ command: 'attack' })).success, false);
  f.profile.behavior.allowBlockBreaking = false;
  assert.equal((await f.adapter.controlPlayer({ command: 'mine_target' })).success, false);
  f.profile.behavior.allowBlockPlacement = false;
  assert.equal((await f.adapter.controlPlayer({ command: 'use' })).success, false);
  assert.equal(f.messages.filter((message) => message.type === 'action').length, 0);
});

test('Fabric malformed snapshots disconnect safely instead of trusting arbitrary state', async (t) => {
  const f = await fixture(t);
  const pending = f.adapter.followPlayer('Friend');
  f.send({ type: 'state', sessionId: 'session-1', controlEpoch: 1, controlsEnabled: true, state: { ...state(), health: 'twenty' } });
  assert.equal((await pending).success, false);
  await waitFor(() => !f.adapter.connected);
  assert.equal(f.events.at(-1)?.data?.intentional, true);
  await assert.rejects(f.adapter.getWorldState(), /No fresh/);
  const invalid = FabricBridgeMessageSchema.safeParse({ type: 'state', sessionId: 'session-1', controlEpoch: 1, controlsEnabled: true,
    state: { ...state(), nearbyPlayers: [{ id: '1', position: { x: 0 } }] } });
  assert.equal(invalid.success, false);
});

test('Fabric stale state cannot dispatch and disconnect shutdown resolves pending actions', async (t) => {
  const f = await fixture(t);
  (f.adapter as unknown as { snapshotAt: number }).snapshotAt = Date.now() - 3001;
  assert.equal(f.adapter.connected, false);
  assert.match((await f.adapter.followPlayer('Friend')).reason!, /stale/);
  f.snapshot(); await waitFor(() => f.adapter.connected);
  const pending = f.adapter.followPlayer('Friend');
  await f.adapter.disconnect('Test shutdown');
  assert.match((await pending).reason!, /Test shutdown/);
  assert.equal(f.adapter.connected, false);
  await f.adapter.disconnect();
  await f.adapter.connect();
  assert.equal(f.adapter.connected, false, 'listener can be started again without a phantom player');
});

test('Fabric oversized frames close the connection and reject pending actions', async (t) => {
  const f = await fixture(t);
  const pending = f.adapter.followPlayer('Friend');
  f.client.send(JSON.stringify({ type: 'hello', oversized: 'x'.repeat(512 * 1024) }));
  assert.equal((await pending).success, false);
  await waitFor(() => !f.adapter.connected);
  assert.equal(f.adapter.controlStatus().enabled, false);
});

test('Fabric unrestricted policy is enabled by local configuration and requires an updated mod', async (t) => {
  const old = await fixture(t, undefined, true, { fabricUnrestricted: true });
  assert.equal(old.adapter.controlStatus().enabled, false);
  assert.match((await old.adapter.followPlayer('Friend')).reason!, /Update the Fabric mod/);
  await waitFor(() => old.messages.some((message) => message.type === 'welcome'));
  assert.equal(old.messages.find((message) => message.type === 'welcome')?.unrestricted, false);

  const bounded = await fixture(t, undefined, true, {}, ['unrestricted-v1']);
  await waitFor(() => bounded.messages.some((message) => message.type === 'welcome'));
  assert.equal(bounded.messages.find((message) => message.type === 'welcome')?.unrestricted, false, 'client capability cannot opt itself into unrestricted mode');
});

test('Fabric unrestricted actions have no implicit timer and explicit stop cancels them', async (t) => {
  const f = await fixture(t, undefined, true, { fabricUnrestricted: true, actionTimeoutMs: 100 }, ['unrestricted-v1']);
  const operation = f.adapter.moveTo({ x: 200, y: 64, z: 2 });
  await waitFor(() => f.messages.some((message) => message.type === 'action'));
  const message = f.messages.find((message) => message.type === 'action')!;
  assert.equal(message.timeoutMs, 0);
  assert.equal(f.messages.find((message) => message.type === 'welcome')?.unrestricted, true);
  const pending = (f.adapter as unknown as { pending: Map<string, { timer: unknown }> }).pending;
  assert.equal(pending.get(message.requestId)?.timer, undefined);
  let completed = false; void operation.then(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(completed, false, 'configured default action deadline is disabled');
  await f.adapter.cancelCurrentAction('Spoken stop');
  assert.match((await operation).reason!, /Spoken stop/);
  assert.equal(pending.size, 0);
});

test('Fabric continuing walks and longer explicit durations require unrestricted mode', async (t) => {
  const f = await fixture(t, undefined, true, { fabricUnrestricted: true }, ['unrestricted-v1']);
  for (const duration of [0, 2000, 70000]) {
    const operation = f.adapter.controlPlayer({ command: 'walk', duration_ms: duration });
    await waitFor(() => f.messages.some((message) => message.type === 'action' && message.arguments.duration_ms === duration));
    const message = f.messages.find((message) => message.type === 'action' && message.arguments.duration_ms === duration)!;
    assert.equal(message.timeoutMs, 0);
    f.send({ type: 'result', sessionId: 'session-1', requestId: message.requestId, result: { success: true, action: 'control_player' } });
    assert.equal((await operation).success, true);
  }
  assert.equal((await f.adapter.controlPlayer({ command: 'jump', duration_ms: 0 })).success, false);
  const explicitDeadline = f.adapter.moveTo({ x: 200, y: 64, z: 2 }, { timeoutMs: 100 });
  assert.match((await explicitDeadline).reason!, /timed out/);
});

test('gameplay capability exposes composite collection and smelting includes recipe output and placement permission', async (t) => {
  const f = await fixture(t, ['smelt_item', 'craft_item', 'equip_item', 'find_block', 'move_to', 'mine_block', 'pickup_items'], true, {}, ['gameplay-skills-v1'], { allowBlockPlacement: false });
  assert.ok(f.adapter.supportedActions.includes('collect_resource'));
  const operation = f.adapter.smeltItem({ input: 'raw_iron', fuel: 'coal', amount: 3 });
  await waitFor(() => f.messages.some((message) => message.type === 'action'));
  const message = f.messages.find((message) => message.type === 'action')!;
  assert.equal(message.arguments.output, 'iron_ingot'); assert.equal(message.arguments.allow_place, false);
  f.send({ type: 'result', sessionId: 'session-1', requestId: message.requestId, result: { success: true, action: 'smelt_item' } });
  assert.equal((await operation).success, true);
  assert.equal((await f.adapter.smeltItem({ input: 'diamond', amount: 1 })).success, false);
  assert.equal(f.messages.filter((message) => message.type === 'action').length, 1);
});

test('excavating navigation cannot bypass the profile block-breaking setting', async (t) => {
  const f = await fixture(t, ['move_to', 'mine_block'], true, {}, ['gameplay-skills-v1'], { allowBlockBreaking: false });
  const result = await f.adapter.moveTo({ x: 5, y: 63, z: 2 }, { canDig: true });
  assert.equal(result.success, false); assert.match(result.reason!, /server profile/);
  assert.equal(f.messages.filter((message) => message.type === 'action').length, 0);
});

test('base-search wire primitives require capability negotiation and honor block-breaking permissions', async (t) => {
  const old = await fixture(t, ['scan_search_area', 'base_search_step']);
  assert.ok(!old.adapter.supportedActions.includes('base_search_step'));
  assert.equal((await old.adapter.baseSearchStep({ x: 2, y: 64, z: 2 })).success, false);
  const f = await fixture(t, ['scan_search_area', 'base_search_step'], true, {}, ['base-search-v1'], { allowBlockBreaking: false });
  assert.ok(f.adapter.supportedActions.includes('scan_search_area'));
  assert.equal((await f.adapter.baseSearchStep({ x: 2, y: 64, z: 2 })).success, false);
  const scan = f.adapter.scanSearchArea(4);
  await waitFor(() => f.messages.some((m) => m.type === 'action'));
  const message = f.messages.find((m) => m.type === 'action')!;
  assert.equal(message.action, 'scan_search_area'); assert.equal(message.arguments.radius, 4);
  f.send({ type: 'result', sessionId: 'session-1', requestId: message.requestId, result: { success: true, action: 'scan_search_area', data: { complete: false, blocks: [] } } });
  assert.equal((await scan).data?.complete, false);
  assert.equal(f.messages.filter((m) => m.type === 'action').length, 1);
});

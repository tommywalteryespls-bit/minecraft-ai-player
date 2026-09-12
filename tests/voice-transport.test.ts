import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import pino from 'pino';
import { SimpleVoiceChatProvider, type VoiceUtterance } from '../src/minecraft/adapters/mineflayer/SimpleVoiceChatProvider.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(dataDir = '.', sendAudio = async (_file: string): Promise<void> => undefined) {
  let connected = true;
  let stopped = false;
  const utterances: VoiceUtterance[] = [];
  const bot = Object.assign(new EventEmitter(), {
    players: {},
    voicechat: {
      isConnected: () => connected,
      getPlayer: (username: string) => username === 'TestPlayer' ? { playerUUID: 'owner-uuid' } : undefined,
      stopAudio: () => { stopped = true; },
      sendAudio
    },
    loadPlugin(plugin: (bot: Bot) => void) { plugin(this as unknown as Bot); }
  });
  const provider = new SimpleVoiceChatProvider(dataDir, pino({ level: 'silent' }), (utterance) => utterances.push(utterance), () => ({
    // Emitting synchronously also verifies listeners are installed before plugin initialization.
    plugin: () => { bot.emit('voicechat_connect'); }
  }));
  provider.attach(bot as unknown as Bot);
  return { bot, provider, utterances, setConnected: (value: boolean) => { connected = value; }, wasStopped: () => stopped };
}

test('voice transport preserves the plugin sender username and resolves its UUID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.provider.detach());
  f.bot.emit('voicechat_player_sound', { sender: 'TestPlayer', channelId: 'voice-channel', distance: 8, data: Buffer.from([1, 2]) });
  t.mock.timers.tick(400);
  f.bot.emit('voicechat_player_sound', { sender: 'TestPlayer', channelId: 'voice-channel', distance: 7, data: Buffer.from([3, 4]) });
  t.mock.timers.tick(850);
  assert.deepEqual(f.utterances, [{ username: 'TestPlayer', senderId: 'owner-uuid', distance: 7, pcm: Buffer.from([1, 2, 3, 4]) }]);
});

test('unresolved voice channels stay separate and pending audio is discarded on disconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.provider.detach());
  f.bot.emit('voicechat_player_sound', { channelId: 'a', distance: 1, data: Buffer.from([1, 2]) });
  f.bot.emit('voicechat_player_sound', { channelId: 'b', distance: 2, data: Buffer.from([3, 4]) });
  t.mock.timers.tick(850);
  assert.equal(f.utterances.length, 2);
  assert.deepEqual(f.utterances.map((item) => [...item.pcm]), [[1, 2], [3, 4]]);
  f.bot.emit('voicechat_player_sound', { sender: 'TestPlayer', distance: 1, data: Buffer.from([5, 6]) });
  f.setConnected(false);
  assert.equal(f.provider.isReady(), false);
  t.mock.timers.tick(850);
  assert.equal(f.utterances.length, 2);
  f.bot.emit('end');
  assert.equal(f.wasStopped(), true);
  assert.equal(f.bot.listenerCount('voicechat_player_sound'), 0);
  assert.equal(f.bot.listenerCount('voicechat_connect'), 0);
});

test('voice playback awaits completion, queues overlapping replies, and removes audio files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-voice-transport-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const firstStarted = deferred();
  const finishFirst = deferred();
  const files: string[] = [];
  const f = fixture(directory, async (file) => {
    files.push(file);
    assert.deepEqual(await fs.readFile(file), Buffer.from([files.length]));
    if (files.length === 1) {
      firstStarted.resolve();
      await finishFirst.promise;
    }
  });
  t.after(() => f.provider.detach());
  let firstCompleted = false;
  const first = f.provider.send(f.bot as unknown as Bot, Buffer.from([1])).then(() => { firstCompleted = true; });
  const second = f.provider.send(f.bot as unknown as Bot, Buffer.from([2]));
  await firstStarted.promise;
  assert.equal(firstCompleted, false);
  assert.equal(files.length, 1);
  finishFirst.resolve();
  await Promise.all([first, second]);
  assert.equal(files.length, 2);
  assert.deepEqual(await fs.readdir(path.join(directory, 'voice', 'outgoing')), []);
});

test('failed voice playback removes its file and does not block subsequent replies', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-voice-transport-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const f = fixture(directory, async () => {
    if (++attempts === 1) throw new Error('FFmpeg conversion failed');
  });
  t.after(() => f.provider.detach());
  await assert.rejects(f.provider.send(f.bot as unknown as Bot, Buffer.from([1])), /FFmpeg conversion failed/);
  assert.deepEqual(await fs.readdir(path.join(directory, 'voice', 'outgoing')), []);
  await f.provider.send(f.bot as unknown as Bot, Buffer.from([2]));
  assert.equal(attempts, 2);
  assert.deepEqual(await fs.readdir(path.join(directory, 'voice', 'outgoing')), []);
});

test('a connection lost during playback is reported as a failure', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-voice-transport-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = fixture(directory, async () => { f.setConnected(false); });
  t.after(() => f.provider.detach());
  await assert.rejects(f.provider.send(f.bot as unknown as Bot, Buffer.from([1])), /disconnected during playback/);
  assert.deepEqual(await fs.readdir(path.join(directory, 'voice', 'outgoing')), []);
});

function handshakeFixture(remoteAddress?: string, fallbackHostname?: string) {
  const logs: string[] = [];
  const settingsPacket = new EventEmitter();
  let settings: { voiceHost: string; serverPort: number };
  const endpoints: Array<{ host: string; port: number }> = [];
  let initialized = false;
  let connected = false;
  let initialize!: (bot: Bot) => void;
  const socketClient = Object.assign(new EventEmitter(), {
    connect() {
      endpoints.push({ host: settings.voiceHost || '127.0.0.1', port: settings.serverPort });
      socketClient.emit('connect');
    }
  });
  const originalConnect = socketClient.connect;
  const bot = Object.assign(new EventEmitter(), {
    players: {},
    _client: { socket: { remoteAddress } },
    voicechat: undefined as unknown as {
      _client: { getPackets(): { secretPacket: EventEmitter }; getSocketClient(): typeof socketClient };
      isConnected(): boolean;
      sendAudio(): Promise<void>;
    },
    loadPlugin(plugin: (bot: Bot) => void) { initialize = plugin; }
  });
  const provider = new SimpleVoiceChatProvider('.', pino({}, { write: (line: string) => logs.push(line) }), () => undefined, () => ({
    plugin: () => {
      initialized = true;
      bot.voicechat = {
        _client: { getPackets: () => ({ secretPacket: settingsPacket }), getSocketClient: () => socketClient },
        isConnected: () => connected,
        sendAudio: async () => undefined
      };
      // Mirror the dependency: its existing listener reads settings and connects immediately.
      settingsPacket.on('packet', (value) => { settings = value; socketClient.connect(); });
    }
  }), fallbackHostname);
  provider.attach(bot as unknown as Bot);
  return {
    bot, provider, endpoints, logs, settingsPacket, socketClient, originalConnect,
    initialize: () => initialize(bot as unknown as Bot),
    initialized: () => initialized,
    serverSettings: (voiceHost: string, serverPort: number) => {
      const packet = { voiceHost, serverPort, secret: 'private-handshake-secret', playerUUID: 'private-player-id' };
      settingsPacket.emit('packet', packet);
      return packet;
    },
    finishHandshake: () => { connected = true; bot.emit('voicechat_connect'); }
  };
}

test('deferred voice plugin uses the resolved Minecraft peer for blank voice hosts and keeps the advertised voice port', async (t) => {
  const f = handshakeFixture('::ffff:203.0.113.20', 'example.test');
  t.after(() => f.provider.detach());
  assert.equal(f.initialized(), false);
  assert.match(f.provider.connectionStatus().reason!, /Waiting for.*server settings/);
  f.initialize();
  f.serverSettings('', 31987);
  assert.deepEqual(f.endpoints, [{ host: '203.0.113.20', port: 31987 }]);
  assert.match(f.provider.connectionStatus().reason!, /UDP voice handshake is incomplete/);
  assert.equal(f.provider.isReady(), false);
  f.finishHandshake();
  assert.deepEqual(f.provider.connectionStatus(), { connected: true });
  assert.ok(f.logs.some((line) => line.includes('minecraft_peer')));
  assert.ok(f.logs.every((line) => !line.includes('private-handshake-secret') && !line.includes('private-player-id')));
});

test('voice handshake preserves explicit endpoints and uses profile hostname only when the resolved peer is unavailable', async (t) => {
  const explicit = handshakeFixture('203.0.113.20', 'example.test');
  const fallback = handshakeFixture(undefined, 'example.test');
  t.after(() => explicit.provider.detach());
  t.after(() => fallback.provider.detach());
  explicit.initialize();
  explicit.serverSettings('voice.example.test:30001', 24454);
  assert.deepEqual(explicit.endpoints, [{ host: 'voice.example.test:30001', port: 24454 }]);
  fallback.initialize();
  fallback.serverSettings('', 31987);
  assert.deepEqual(fallback.endpoints, [{ host: 'example.test', port: 31987 }]);
});

test('blank voice endpoints without a usable server address fail clearly without connecting to localhost', async (t) => {
  const f = handshakeFixture();
  t.after(() => f.provider.detach());
  f.initialize();
  f.serverSettings('', 24454);
  assert.deepEqual(f.endpoints, []);
  assert.match(f.provider.connectionStatus().reason!, /server address could not be resolved/);
  // Later valid server settings can still recover the connection.
  f.serverSettings('voice.example.test', 24454);
  assert.equal(f.endpoints.length, 1);
  assert.match(f.provider.connectionStatus().reason!, /handshake is incomplete/);
});

test('voice handshake diagnostics clean up on detach and deferred plugins cannot initialize afterward', async () => {
  const active = handshakeFixture('203.0.113.20');
  active.initialize();
  assert.equal(active.settingsPacket.listenerCount('packet'), 2);
  active.serverSettings('', 24454);
  active.socketClient.emit('close');
  assert.match(active.provider.connectionStatus().reason!, /connection closed/);
  await active.provider.detach();
  assert.equal(active.settingsPacket.listenerCount('packet'), 1);
  assert.equal(active.socketClient.listenerCount('connect'), 0);
  assert.equal(active.socketClient.listenerCount('close'), 0);
  assert.equal(active.socketClient.listenerCount('error'), 0);
  assert.equal(active.socketClient.connect, active.originalConnect);
  const delayed = handshakeFixture('203.0.113.20');
  await delayed.provider.detach();
  delayed.initialize();
  assert.equal(delayed.initialized(), false);
  assert.equal(delayed.provider.isReady(), false);
});

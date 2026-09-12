import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { AutonomousAgent } from '../src/core/agent.js';
import { TestMinecraftAgent } from '../src/minecraft/adapters/test/TestMinecraftAgent.js';
import type { MinecraftEvent, MinecraftEventListener } from '../src/minecraft/types.js';
import { Planner, type PlannerResult } from '../src/ai/planner.js';
import type { AgentEvent } from '../src/core/events.js';
import { ToolExecutor } from '../src/ai/toolExecutor.js';
import { ActionScheduler } from '../src/core/actionScheduler.js';
import { BrowserVoiceServer } from '../src/voice/browserServer.js';
import type { MinecraftAgent } from '../src/minecraft/MinecraftAgent.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ConversationMinecraft extends TestMinecraftAgent {
  controlStatus?: MinecraftAgent['controlStatus'];
  listener: MinecraftEventListener | undefined;
  texts: string[] = [];
  override subscribe(listener: MinecraftEventListener): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  async receive(type: MinecraftEvent['type'] = 'PLAYER_SPOKE', message = 'Hello') {
    await this.listener?.({ type, serverId: this.serverId, timestamp: new Date().toISOString(), username: 'TestPlayer', message,
      audio: type === 'PLAYER_SPOKE' ? Buffer.alloc(9600) : undefined });
  }
  override async sayText(message: string) {
    this.texts.push(message);
    return { success: true, action: 'say' };
  }
  voiceStatus() { return { connected: this.connected }; }
}

async function fixture(commandOnly = false) {
  const minecraft = new ConversationMinecraft('voice-test-server');
  await minecraft.connect();
  const spoken: string[] = [];
  const heard: Buffer[] = [];
  const history: Array<{ direction: string; channel: string; message: string }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino({ level: 'info' }, { write: (line) => { logs.push(JSON.parse(line)); } });
  const planner = {
    busy: false,
    think: async (_event?: AgentEvent, _signal?: AbortSignal): Promise<PlannerResult> => ({ text: 'Hello, TestPlayer.', responseId: 'resp_test', toolCalls: 0, toolNames: [] }),
    close: () => {}, cancel: () => {}
  };
  const voice = {
    transcribe: async (audio: Buffer) => { heard.push(audio); return 'Hello'; },
    transcribeBrowser: async (audio: Buffer, _signal?: AbortSignal) => { heard.push(audio); return 'Follow me'; },
    generateSpeech: async (text: string, _signal?: AbortSignal) => { spoken.push(text); return Buffer.from('mock mp3'); },
    speak: async (text: string, _signal?: AbortSignal): Promise<{ success: boolean; reason?: string }> => { spoken.push(text); return { success: true }; },
    close: () => {},
    status: () => ({ enabled: true, transcribeModel: 'mock-transcribe', ttsModel: 'mock-tts', voice: 'onyx' })
  };
  const config = { autonomousEnabled: false, thinkIntervalMs: 60_000, openaiApiKey: 'test-only', openaiModel: 'mock-planner',
    transcribeModel: 'mock-transcribe', voiceTextFallback: true, aiName: 'Astra', owner: 'TestPlayer' };
  type Args = ConstructorParameters<typeof AutonomousAgent>;
  const agent = new AutonomousAgent(minecraft, planner as unknown as Args[1], {
    touchPlayer: () => {}, recordConversation: (record: typeof history[number]) => history.push(record), recordEvent: () => {}
  } as unknown as Args[2], {} as Args[3], {} as Args[4], voice as unknown as Args[5],
  { stop: async () => {} } as unknown as Args[6], { start: () => {}, stop: () => {} } as unknown as Args[7], config as Args[8], logger, false, commandOnly);
  agent.start();
  return { agent, minecraft, planner, voice, spoken, heard, history, logs, config };
}

test('a voice transcript produces speech and stores the actual outgoing voice reply', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  await f.minecraft.receive();
  assert.equal(f.heard.length, 1);
  assert.deepEqual(f.spoken, ['Hello, TestPlayer.']);
  assert.deepEqual(f.minecraft.texts, []);
  assert.deepEqual(f.history.map((r) => [r.direction, r.channel]), [['incoming', 'voice'], ['outgoing', 'voice']]);
});

test('messages arriving during playback wait in order instead of being dropped or overlapping', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  const started = deferred<void>(); const release = deferred<void>();
  let calls = 0;
  f.voice.speak = async (text) => {
    f.spoken.push(text);
    if (++calls === 1) { started.resolve(); await release.promise; }
    return { success: true };
  };
  const first = f.minecraft.receive();
  await started.promise;
  const second = f.minecraft.receive();
  assert.equal(f.agent.voiceStatus().pendingMessages, 2);
  assert.equal(f.heard.length, 1);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(f.heard.length, 2);
  assert.equal(f.spoken.length, 2);
  assert.equal(f.agent.voiceStatus().pendingMessages, 0);
});

test('speech delivery failure falls back to text even if a planner reports a say call', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  f.planner.think = async () => ({ text: 'I can hear you.', responseId: 'r', toolCalls: 1, toolNames: ['say'] });
  f.voice.speak = async () => ({ success: false, reason: 'UDP disconnected' });
  await f.minecraft.receive();
  assert.deepEqual(f.minecraft.texts, ['I can hear you.']);
  assert.equal(f.history.at(-1)?.channel, 'text');
  assert.ok(f.logs.some((log) => log.stage === 'voice-output' && log.reason === 'UDP disconnected'));
});

test('disabled text fallback does not record failed speech as delivered', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  f.config.voiceTextFallback = false;
  f.voice.speak = async () => ({ success: false, reason: 'TTS failed' });
  await f.minecraft.receive();
  assert.equal(f.history.filter((r) => r.direction === 'outgoing').length, 0);
  assert.deepEqual(f.minecraft.texts, []);
});

test('transcription and planning failures are labelled separately and release the conversation queue', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  f.voice.transcribe = async () => { throw new Error('transcription failed'); };
  await f.minecraft.receive();
  assert.ok(f.logs.some((log) => log.stage === 'transcription' && log.msg === 'Voice transcription failed'));
  assert.equal(f.history.length, 0);
  f.voice.transcribe = async () => 'Hello';
  f.planner.think = async () => { throw new Error('planning failed'); };
  await f.minecraft.receive();
  assert.ok(f.logs.some((log) => log.stage === 'planning' && log.msg === 'Player reply planning failed'));
  assert.equal(f.spoken.length, 0);
  assert.match(f.minecraft.texts[0]!, /heard you/);
  assert.equal(f.agent.voiceStatus().pendingMessages, 0);
});

test('shutdown prevents active and queued conversations from replying', async () => {
  const f = await fixture();
  const started = deferred<void>(); const release = deferred<PlannerResult>();
  f.planner.think = async () => { started.resolve(); return release.promise; };
  const first = f.minecraft.receive();
  await started.promise;
  const second = f.minecraft.receive();
  await f.agent.stop();
  release.resolve({ text: 'Stale response', responseId: 'old', toolCalls: 0, toolNames: [] });
  await Promise.all([first, second]);
  assert.equal(f.heard.length, 1);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.history.filter((r) => r.direction === 'outgoing').length, 0);
});

test('disconnect followed by reconnect discards conversations from the old connection', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  const started = deferred<void>(); const release = deferred<PlannerResult>();
  let cancelled = 0;
  f.planner.cancel = () => { cancelled += 1; };
  f.planner.think = async () => { started.resolve(); return release.promise; };
  const first = f.minecraft.receive();
  await started.promise;
  const second = f.minecraft.receive();
  await f.minecraft.receive('SERVER_DISCONNECTED');
  release.resolve({ text: 'Old session', responseId: 'old', toolCalls: 0, toolNames: [] });
  await Promise.all([first, second]);
  assert.equal(cancelled, 1);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.heard.length, 1);
});

test('voice test bypasses the planner and transcription and reports playback failure accurately', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  f.planner.think = async () => { assert.fail('voice-test should not plan'); };
  f.voice.transcribe = async () => { assert.fail('voice-test should not transcribe'); };
  assert.deepEqual(await f.agent.testVoice('Voice test.'), { success: true });
  assert.deepEqual(f.spoken, ['Voice test.']);
  f.voice.speak = async () => ({ success: false, reason: 'No voice transport' });
  assert.deepEqual(await f.agent.testVoice('Again'), { success: false, reason: 'No voice transport' });
  assert.equal(f.history.length, 0);
});

test('disconnect aborts speech already generating and a reconnected conversation receives a fresh signal', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  const started = deferred<void>(); const release = deferred<void>();
  const signals: AbortSignal[] = [];
  f.voice.speak = async (text, signal) => {
    assert.ok(signal, 'voice playback must receive the connection cancellation signal');
    signals.push(signal);
    if (signals.length === 1) { started.resolve(); await release.promise; }
    if (signal.aborted) return { success: false, reason: 'Connection closed during speech generation' };
    f.spoken.push(text);
    return { success: true };
  };
  const oldConversation = f.minecraft.receive();
  await started.promise;
  const oldQueuedConversation = f.minecraft.receive();
  f.minecraft.connected = false;
  await f.minecraft.receive('SERVER_DISCONNECTED');
  assert.equal(signals[0]?.aborted, true);
  f.minecraft.connected = true;
  const newConversation = f.minecraft.receive();
  release.resolve();
  await Promise.all([oldConversation, oldQueuedConversation, newConversation]);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[1], signals[0]);
  assert.equal(signals[1]?.aborted, false);
  assert.equal(f.heard.length, 2);
  assert.deepEqual(f.spoken, ['Hello, TestPlayer.']);
  assert.deepEqual(f.minecraft.texts, []);
  assert.equal(f.history.filter((record) => record.direction === 'outgoing').length, 1);
  assert.equal(f.agent.voiceStatus().pendingMessages, 0);
});

test('voice-test speech carries the same shutdown cancellation as normal conversations', async () => {
  const f = await fixture();
  const started = deferred<AbortSignal>(); const release = deferred<void>();
  f.voice.speak = async (_text, signal) => {
    assert.ok(signal);
    started.resolve(signal);
    await release.promise;
    return { success: !signal.aborted, reason: signal.aborted ? 'Voice test cancelled' : undefined };
  };
  const testPlayback = f.agent.testVoice('A delayed voice test.');
  const signal = await started.promise;
  assert.equal(signal.aborted, false);
  await f.agent.stop();
  assert.equal(signal.aborted, true);
  release.resolve();
  assert.deepEqual(await testPlayback, { success: false, reason: 'Voice test cancelled' });
  assert.equal(f.history.length, 0);
});

test('browser voice routes owner identity through the planner without any Minecraft voice or chat playback', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  f.minecraft.voiceStatus = () => ({ connected: false });
  f.voice.speak = async () => { assert.fail('browser must not use game voice'); };
  const events: AgentEvent[] = [];
  f.planner.think = async (event) => {
    events.push(event!);
    return { text: 'I am following you.', responseId: 'r', toolCalls: 1, toolNames: ['follow_player'] };
  };
  const result = await f.agent.converseFromBrowser(Buffer.alloc(9600));
  assert.equal(result.success, true);
  assert.equal(result.transcript, 'Follow me');
  assert.deepEqual(result.tools, ['follow_player']);
  assert.equal(Buffer.from(result.audioBase64!, 'base64').toString(), 'mock mp3');
  assert.equal(events[0]?.data?.username, 'TestPlayer');
  assert.equal(events[0]?.data?.channel, 'voice');
  assert.equal(events[0]?.data?.transport, 'browser');
  assert.deepEqual(f.minecraft.texts, []);
  assert.equal(f.history.at(-1)?.channel, 'text', 'unacknowledged browser playback is not recorded as audible delivery');
});

test('browser TTS failure preserves transcript and command reply without leaking it into game chat', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  f.voice.generateSpeech = async () => { throw new Error('TTS unavailable'); };
  const result = await f.agent.converseFromBrowser(Buffer.alloc(9600));
  assert.equal(result.success, false); assert.equal(result.stage, 'tts');
  assert.equal(result.transcript, 'Follow me'); assert.equal(result.reply, 'Hello, TestPlayer.');
  assert.deepEqual(f.minecraft.texts, []);
});

test('browser and Minecraft conversations share queue; cancelled queued turns do not transcribe', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  const started = deferred<void>(), release = deferred<void>();
  f.voice.transcribeBrowser = async (audio) => { f.heard.push(audio); started.resolve(); await release.promise; return 'Hi'; };
  const first = f.agent.converseFromBrowser(Buffer.alloc(9600));
  await started.promise;
  const controller = new AbortController();
  const cancelled = f.agent.converseFromBrowser(Buffer.alloc(9600), controller.signal);
  const game = f.minecraft.receive();
  controller.abort(); release.resolve();
  assert.equal((await first).success, true);
  assert.equal((await cancelled).stage, 'availability');
  await game;
  assert.equal(f.heard.length, 2); assert.equal(f.agent.voiceStatus().pendingMessages, 0);
});

test('browser cancellation during planning is request-local and prevents subsequent speech', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  const started = deferred<void>(), release = deferred<void>();
  const controller = new AbortController(); let seen: AbortSignal | undefined;
  f.planner.think = async (_event, signal) => { seen = signal; started.resolve(); await release.promise;
    return { text: 'Late', responseId: 'r', toolCalls: 0, toolNames: [] }; };
  const pending = f.agent.converseFromBrowser(Buffer.alloc(9600), controller.signal);
  await started.promise; controller.abort(); assert.equal(seen?.aborted, true); release.resolve();
  assert.equal((await pending).stage, 'availability'); assert.equal(f.spoken.length, 0);
  assert.equal((await f.agent.converseFromBrowser(Buffer.alloc(9600))).success, true);
});

test('browser disconnect invalidates active requests and invalid owner/audio never starts STT', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  f.config.owner = 'email@example.com';
  assert.equal((await f.agent.converseFromBrowser(Buffer.alloc(9600))).success, false);
  f.config.owner = 'TestPlayer';
  assert.equal((await f.agent.converseFromBrowser(Buffer.alloc(9601))).success, false);
  assert.equal(f.heard.length, 0);
  const started = deferred<void>(), release = deferred<void>();
  f.voice.transcribeBrowser = async (_audio, signal) => { started.resolve(); await release.promise; assert.equal(signal?.aborted, true); return 'Hello'; };
  const pending = f.agent.converseFromBrowser(Buffer.alloc(9600)); await started.promise;
  await f.minecraft.receive('SERVER_DISCONNECTED'); release.resolve();
  assert.equal((await pending).stage, 'availability'); assert.equal(f.spoken.length, 0);
});

test('HTTP browser voice reaches actual planner and tool executor to follow the configured Minecraft owner', async (t) => {
  const f = await fixture(); t.after(() => f.agent.stop());
  const followed: string[] = [];
  f.minecraft.followPlayer = async (username) => { followed.push(username); return { success: true, action: 'follow_player' }; };
  const logger = pino({ level: 'silent' });
  const scheduler = new ActionScheduler(f.minecraft, logger); t.after(() => scheduler.stop());
  type E = ConstructorParameters<typeof ToolExecutor>;
  const executor = new ToolExecutor(f.minecraft, { recordAction() {} } as unknown as E[1], scheduler, {} as E[3], {} as E[4], { actionTimeoutMs: 1000 } as E[5]);
  let apiCalls = 0;
  type P = ConstructorParameters<typeof Planner>;
  const planner = new Planner({ requireClient: () => ({ responses: { create: async (body: { input: string }) => {
    if (++apiCalls === 1) {
      assert.match(body.input, /TestPlayer/);
      return { id: 'tool', status: 'completed', output_text: '', output: [{ type: 'function_call', call_id: 'follow', name: 'follow_player', arguments: '{"username":"TestPlayer"}' }] };
    }
    assert.deepEqual(followed, ['TestPlayer']);
    return { id: 'reply', status: 'completed', output_text: 'I am following you.', output: [] };
  } } }) } as unknown as P[0], { build: async () => ({}) } as unknown as P[1], executor, logger, 'Astra', 'TestPlayer', 'mock-planner', 2);
  f.planner.think = (event, signal) => planner.think(event!, signal); t.after(() => planner.close());
  const server = new BrowserVoiceServer({ status: () => ({}), converse: (audio, signal) => f.agent.converseFromBrowser(audio, signal) });
  const url = await server.listen(0); t.after(() => server.close());
  const { token } = await (await fetch(url + '/api/session')).json() as { token: string };
  const response = await fetch(url + '/api/voice', { method: 'POST', headers: { Origin: url, 'X-Voice-Token': token, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(9600) });
  const result = await response.json() as { success: boolean; reply: string; audioBase64: string };
  assert.equal(result.success, true); assert.equal(result.reply, 'I am following you.');
  assert.equal(Buffer.from(result.audioBase64, 'base64').toString(), 'mock mp3');
  assert.deepEqual(followed, ['TestPlayer']); assert.deepEqual(f.minecraft.texts, []);
});

test('Fabric command-only mode ignores other players and world events and cannot enable autonomy', async (t) => {
  const f = await fixture(true); t.after(() => f.agent.stop());
  let calls = 0;
  f.planner.think = async () => { calls++; return { text: 'Do not run', responseId: 'r', toolCalls: 0, toolNames: [] }; };
  for (const type of ['CHAT_MESSAGE', 'DAMAGE_TAKEN', 'SERVER_CONNECTED', 'NEW_DAY', 'PLAYER_SPOKE'] as const) await f.minecraft.receive(type);
  assert.equal(calls, 0); assert.equal(f.heard.length, 0); assert.equal(f.spoken.length, 0);
  assert.throws(() => f.agent.setAutonomy(true), /command-only/);
  await assert.rejects(f.agent.thinkNow(), /explicit voice command/);
});

test('Fabric voice is bound to the controlled player and refuses disarmed commands before API processing', async (t) => {
  const f = await fixture(true); t.after(() => f.agent.stop());
  let enabled = false;
  f.minecraft.controlStatus = () => ({ enabled, username: 'MyRealPlayer', reason: enabled ? undefined : 'Press F8' });
  assert.equal((await f.agent.converseFromBrowser(Buffer.alloc(9600))).reason, 'Press F8');
  assert.equal(f.heard.length, 0);
  enabled = true;
  f.planner.think = async (event) => {
    assert.equal(event?.data?.username, 'MyRealPlayer');
    return { text: 'Jumped.', responseId: 'r', toolCalls: 1, toolNames: ['control_player'] };
  };
  assert.equal((await f.agent.converseFromBrowser(Buffer.alloc(9600))).success, true);
});

test('Fabric emergency disable invalidates both active and queued voice turns', async (t) => {
  const f = await fixture(true); t.after(() => f.agent.stop());
  let enabled = true, plans = 0;
  f.minecraft.controlStatus = () => ({ enabled, username: 'TestPlayer' });
  const started = deferred<void>(), release = deferred<void>();
  f.voice.transcribeBrowser = async () => { started.resolve(); await release.promise; return 'Walk'; };
  f.planner.think = async () => { plans++; return { text: '', responseId: null, toolCalls: 0, toolNames: [] }; };
  const first = f.agent.converseFromBrowser(Buffer.alloc(9600)); await started.promise;
  const queued = f.agent.converseFromBrowser(Buffer.alloc(9600));
  enabled = false; await f.minecraft.receive('CONTROL_DISABLED'); release.resolve();
  assert.equal((await first).success, false); assert.equal((await queued).success, false);
  assert.equal(plans, 0); assert.equal(f.spoken.length, 0);
});

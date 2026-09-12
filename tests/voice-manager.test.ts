import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ReadStream } from 'node:fs';
import test from 'node:test';
import pino from 'pino';
import type { OpenAIRealtimeWS } from 'openai/realtime/ws';
import type { OpenAIService } from '../src/ai/openai.js';
import type { AppConfig } from '../src/config.js';
import type { MinecraftAgent } from '../src/minecraft/MinecraftAgent.js';
import { serializeError } from '../src/utils/errors.js';
import { RealtimeTranscriber } from '../src/voice/realtime.js';
import { VoiceManager } from '../src/voice/voiceManager.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: {
  speech?: (...args: any[]) => Promise<unknown>;
  transcription?: (...args: any[]) => Promise<unknown>;
  playback?: (...args: any[]) => Promise<unknown>;
  status?: () => { connected: boolean; reason?: string };
  realtime?: { transcribe: (pcm: Buffer) => Promise<string>; close: () => void };
  dataDir?: string;
} = {}) {
  const logs: Record<string, unknown>[] = [];
  const logger = pino({ level: 'info' }, { write: (line) => { logs.push(JSON.parse(line)); } });
  let speechCalls = 0;
  let playbackCalls = 0;
  const openai = {
    enabled: true,
    requireClient: () => ({ audio: {
      speech: { create: async (...args: any[]) => {
        speechCalls++;
        return options.speech ? options.speech(...args) : { arrayBuffer: async () => Buffer.from('mock mp3') };
      } },
      transcriptions: { create: options.transcription ?? (async () => ({ text: ' hello ' })) }
    } })
  } as unknown as OpenAIService;
  const minecraft = {
    voiceStatus: options.status,
    speakAudio: async (...args: any[]) => {
      playbackCalls++;
      return options.playback ? options.playback(...args) : { success: true, action: 'speak_audio' };
    }
  } as unknown as MinecraftAgent;
  const config = {
    voiceEnabled: true, transcribeModel: 'test-transcribe', ttsModel: 'test-tts', voice: 'onyx', dataDir: options.dataDir
  } as AppConfig;
  const manager = new VoiceManager(minecraft, openai, config, logger, options.realtime ?? {
    transcribe: async () => 'hello', close: () => undefined
  });
  return { manager, logs, calls: () => ({ speechCalls, playbackCalls }) };
}

test('browser transcription uploads WAV in memory and speech ignores unavailable game voice', async () => {
  const f = fixture({ status: () => ({ connected: false }), transcription: async (body: { file: File }, options: { signal: AbortSignal }) => {
    const wav = Buffer.from(await body.file.arrayBuffer());
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 48000);
    assert.equal(wav.length, 9644); assert.equal(options.signal.aborted, false);
    return { text: ' follow me ' };
  } });
  assert.equal(await f.manager.transcribeBrowser(Buffer.alloc(9600)), 'follow me');
  assert.equal((await f.manager.generateSpeech('Following you.')).toString(), 'mock mp3');
  assert.deepEqual(f.calls(), { speechCalls: 1, playbackCalls: 0 });
  f.manager.close();
});

test('cancelled browser requests never start speech/transcription API calls', async () => {
  const f = fixture({ transcription: async () => { assert.fail('cancelled upload'); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.manager.transcribeBrowser(Buffer.alloc(9600), controller.signal));
  await assert.rejects(f.manager.generateSpeech('Do not speak', controller.signal));
  assert.equal(f.calls().speechCalls, 0); f.manager.close();
});

test('error serialization keeps non-enumerable diagnostics and excludes credentials and raw headers', () => {
  const error = Object.assign(new Error('Unauthorized sk-proj-FAKE_SECRET; Bearer FAKE_TOKEN'), {
    status: 401, code: 'invalid_api_key', request_id: 'req_test',
    headers: { Authorization: 'FAKE_HEADER' }, apiKey: 'FAKE_KEY',
    cause: Object.assign(new Error('Underlying error'), { code: 'ECONNRESET', password: 'FAKE_PASSWORD' })
  });
  const result = serializeError(error);
  assert.equal(result.message, 'Unauthorized [REDACTED]; Bearer [REDACTED]');
  assert.equal(result.status, 401);
  assert.equal(result.code, 'invalid_api_key');
  assert.equal(result.requestId, 'req_test');
  assert.equal(result.cause?.code, 'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(result), /FAKE_|headers|apiKey|password/);
  const circular = new Error('cycle');
  circular.cause = circular;
  assert.equal(serializeError(circular).cause?.message, '[Circular error]');
  assert.equal(serializeError({ error: { message: 'quota exceeded', code: 'insufficient_quota' } }).code, 'insufficient_quota');
});

test('realtime transcription fallback logs the actual stages and deletes the temporary recording', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-voice-test-'));
  let closed = 0;
  const { manager, logs } = fixture({
    dataDir,
    realtime: { transcribe: async () => { throw Object.assign(new Error('Realtime quota'), { status: 429 }); }, close: () => { closed++; } },
    transcription: async ({ file }: { file: ReadStream }) => {
      for await (const _chunk of file) { /* consume the mocked upload */ }
      return { text: ' follow me ' };
    }
  });
  try {
    assert.equal(await manager.transcribe(Buffer.alloc(9600)), 'follow me');
    assert.equal(closed, 1);
    assert.equal(manager.status().transcriptionTransport, 'file');
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'voice', 'incoming')), []);
    assert.ok(logs.some((log) => log.stage === 'transcription' && log.transport === 'file' && log.characters === 9));
    assert.ok(logs.some((log) => (log.error as { status?: number })?.status === 429));
  } finally {
    manager.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('TTS errors and unsuccessful Minecraft playback are reported separately', async () => {
  const tts = fixture({ speech: async () => { throw Object.assign(new Error('No credits'), { code: 'credit_balance_exhausted' }); } });
  assert.deepEqual(await tts.manager.speak('Hi'), { success: false, stage: 'tts', reason: 'No credits' });
  assert.equal(tts.calls().playbackCalls, 0);
  assert.ok(tts.logs.some((log) => log.stage === 'tts' && (log.error as { code?: string })?.code === 'credit_balance_exhausted'));
  tts.manager.close();
  const playback = fixture({ playback: async () => ({ success: false, reason: 'Voice UDP disconnected' }) });
  assert.deepEqual(await playback.manager.speak('Hi'), { success: false, stage: 'playback', reason: 'Voice UDP disconnected' });
  assert.ok(playback.logs.some((log) => log.msg === 'Minecraft voice playback failed'));
  playback.manager.close();
});

test('failed file transcription preserves the API cause and cleans an unopened upload stream', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-voice-test-'));
  const apiError = Object.assign(new Error('Transcription denied'), { status: 403, code: 'permission_denied' });
  const { manager, logs } = fixture({
    dataDir,
    realtime: { transcribe: async () => { throw new Error('WebSocket unavailable'); }, close: () => undefined },
    transcription: async () => { throw apiError; }
  });
  try {
    await assert.rejects(manager.transcribe(Buffer.alloc(9600)), (error) => error === apiError);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'voice', 'incoming')), []);
    assert.ok(logs.some((log) => log.msg === 'Voice transcription failed' && (log.error as { code?: string })?.code === 'permission_denied'));
  } finally {
    manager.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('disconnected voice transport skips TTS and is rechecked after synthesis', async () => {
  const disconnected = fixture({ status: () => ({ connected: false, reason: 'Voice plugin is not ready' }) });
  assert.equal((await disconnected.manager.speak('Hi')).stage, 'playback');
  assert.equal(disconnected.calls().speechCalls, 0);
  disconnected.manager.close();
  let connected = true;
  const interrupted = fixture({
    status: () => ({ connected }),
    speech: async () => { connected = false; return { arrayBuffer: async () => Buffer.from('audio') }; }
  });
  assert.equal((await interrupted.manager.speak('Hi')).stage, 'playback');
  assert.equal(interrupted.calls().playbackCalls, 0);
  interrupted.manager.close();
});

test('voice output is serialized and shutdown cancels queued output and discards late TTS', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  let signal: AbortSignal | undefined;
  const { manager, calls } = fixture({
    speech: async (_request, options: { signal: AbortSignal }) => {
      signal = options.signal;
      started.resolve();
      await release.promise;
      return { arrayBuffer: async () => Buffer.from('audio') };
    }
  });
  const first = manager.speak('First');
  await started.promise;
  const second = manager.speak('Second');
  assert.equal(calls().speechCalls, 1);
  manager.close();
  assert.equal(signal?.aborted, true);
  release.resolve();
  assert.equal((await first).success, false);
  assert.equal((await second).success, false);
  assert.deepEqual(calls(), { speechCalls: 1, playbackCalls: 0 });
  await assert.rejects(manager.transcribe(Buffer.alloc(100)), /closed/);
});

test('cancelling a conversation discards late TTS even when voice transport has reconnected', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const cancellation = new AbortController();
  let signal: AbortSignal | undefined;
  const { manager, calls } = fixture({
    status: () => ({ connected: true }),
    speech: async (_request, options: { signal: AbortSignal }) => {
      signal = options.signal;
      started.resolve();
      await release.promise;
      return { arrayBuffer: async () => Buffer.from('audio') };
    }
  });
  const result = manager.speak('Reply from old connection', cancellation.signal);
  await started.promise;
  cancellation.abort();
  assert.equal(signal?.aborted, true);
  release.resolve();
  assert.equal((await result).stage, 'availability');
  assert.equal(calls().playbackCalls, 0);
  assert.equal(manager.enabled, true);
  manager.close();
});

class MockRealtime extends EventEmitter {
  readonly socket = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1 });
  readonly sent: string[] = [];
  closed = false;
  onCommit?: () => void;
  send(event: { type: string }): void {
    this.sent.push(event.type);
    if (event.type === 'session.update') queueMicrotask(() => this.emit('session.updated', {}));
    if (event.type === 'input_audio_buffer.commit') this.onCommit?.();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.readyState = 3;
    this.socket.emit('close');
  }
}

test('Realtime API errors reject active transcription and remove listeners immediately', async () => {
  const connection = new MockRealtime();
  const apiError = Object.assign(new Error('Realtime denied'), { code: 'model_not_found' });
  connection.onCommit = () => connection.emit('error', apiError);
  const transcriber = new RealtimeTranscriber({} as OpenAIService, 'test-transcribe', () => {
    queueMicrotask(() => connection.emit('session.created', {}));
    return connection as unknown as OpenAIRealtimeWS;
  });
  await assert.rejects(transcriber.transcribe(Buffer.alloc(9600)), (error) => error === apiError);
  assert.equal(connection.closed, true);
  assert.deepEqual(connection.sent, ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit']);
  assert.equal(connection.listenerCount('conversation.item.input_audio_transcription.completed'), 0);
  assert.equal(connection.listenerCount('session.updated'), 0);
  assert.equal(connection.socket.listenerCount('close'), 0);
  transcriber.close();
});

test('Realtime shutdown cancels an unfinished handshake and queued transcriptions', async () => {
  const connection = new MockRealtime();
  const started = deferred<void>();
  let attempts = 0;
  const transcriber = new RealtimeTranscriber({} as OpenAIService, 'test-transcribe', () => {
    attempts++;
    started.resolve();
    return connection as unknown as OpenAIRealtimeWS;
  });
  const first = transcriber.transcribe(Buffer.alloc(9600));
  const second = transcriber.transcribe(Buffer.alloc(9600));
  const firstRejected = assert.rejects(first, /closed/);
  const secondRejected = assert.rejects(second, /closed/);
  await started.promise;
  transcriber.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(attempts, 1);
  assert.equal(connection.closed, true);
  assert.equal(connection.listenerCount('session.created'), 0);
});

import { Mutex } from '../utils/mutex.js';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import type { OpenAIService } from '../ai/openai.js';
import { pcm16le48kTo24k } from './audioUtils.js';

export class RealtimeTranscriber {
  private connection: OpenAIRealtimeWS | null = null;
  private readonly mutex = new Mutex();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly openai: OpenAIService,
    private readonly transcriptionModel: string,
    private readonly connect: () => OpenAIRealtimeWS = () => new OpenAIRealtimeWS({ intent: 'transcription' }, openai.requireClient())
  ) {}

  async transcribe(pcm48k: Buffer): Promise<string> {
    return this.mutex.runExclusive(async () => {
      this.assertOpen();
      const connection = await this.ensureConnection();
      this.assertOpen();
      try {
        return await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            failed(new Error('Realtime transcription timed out'));
          }, 20_000);
          const completed = (event: { transcript: string }) => {
            cleanup();
            resolve(event.transcript.trim());
          };
          const failed = (error: unknown) => {
            cleanup();
            reject(error);
          };
          const transcriptionFailed = (event: { error: unknown }) => failed(new Error('Realtime transcription failed', { cause: event.error }));
          const closed = () => failed(new Error('Realtime connection closed during transcription'));
          const aborted = () => failed(new Error('Realtime transcriber is closed'));
          const cleanup = () => {
            clearTimeout(timeout);
            connection.off('conversation.item.input_audio_transcription.completed', completed);
            connection.off('conversation.item.input_audio_transcription.failed', transcriptionFailed);
            connection.off('error', failed);
            connection.socket.off('close', closed);
            this.shutdown.signal.removeEventListener('abort', aborted);
          };
          connection.on('conversation.item.input_audio_transcription.completed', completed);
          connection.on('conversation.item.input_audio_transcription.failed', transcriptionFailed);
          connection.on('error', failed);
          connection.socket.once('close', closed);
          this.shutdown.signal.addEventListener('abort', aborted, { once: true });
          try {
            connection.send({ type: 'input_audio_buffer.append', audio: pcm16le48kTo24k(pcm48k).toString('base64') });
            connection.send({ type: 'input_audio_buffer.commit' });
          } catch (error) {
            failed(error);
          }
        });
      } catch (error) {
        // Discard this session so a late transcript cannot become the next speaker's reply.
        if (this.connection === connection) this.connection = null;
        connection.close();
        throw error;
      }
    });
  }

  close(): void {
    this.shutdown.abort();
    this.connection?.close({ code: 1000, reason: 'Voice manager shutdown' });
    this.connection = null;
  }

  private async ensureConnection(): Promise<OpenAIRealtimeWS> {
    this.assertOpen();
    const current = this.connection;
    if (current && current.socket.readyState === current.socket.OPEN) return current;
    const connection = this.connect();
    // Keep a handle while connecting so shutdown can close an unfinished handshake.
    this.connection = connection;
    connection.on('error', () => {
      if (this.connection !== connection) return;
      this.connection = null;
      // Also dispose failed idle sessions; let active listeners observe the original error first.
      queueMicrotask(() => connection.close());
    });
    connection.socket.once('close', () => {
      if (this.connection === connection) this.connection = null;
    });
    try {
      await this.waitForSession(connection, 'session.created');
      await this.waitForSession(connection, 'session.updated', () => connection.send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: this.transcriptionModel },
              turn_detection: null
            }
          }
        }
      }));
      this.assertOpen();
      return connection;
    } catch (error) {
      if (this.connection === connection) this.connection = null;
      connection.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.shutdown.signal.aborted) throw new Error('Realtime transcriber is closed');
  }

  private waitForSession(connection: OpenAIRealtimeWS, event: 'session.created' | 'session.updated', start?: () => void): Promise<void> {
    this.assertOpen();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => failed(new Error(`Realtime ${event} timed out`)), 15_000);
      const cleanup = () => {
        clearTimeout(timeout);
        connection.off(event, completed);
        connection.off('error', failed);
        connection.socket.off('close', closed);
        this.shutdown.signal.removeEventListener('abort', aborted);
      };
      const completed = () => { cleanup(); resolve(); };
      const failed = (error: unknown) => { cleanup(); reject(error); };
      const closed = () => failed(new Error(`Realtime connection closed before ${event}`));
      const aborted = () => failed(new Error('Realtime transcriber is closed'));
      connection.once(event, completed);
      connection.on('error', failed);
      connection.socket.once('close', closed);
      this.shutdown.signal.addEventListener('abort', aborted, { once: true });
      try { start?.(); } catch (error) { failed(error); }
    });
  }
}

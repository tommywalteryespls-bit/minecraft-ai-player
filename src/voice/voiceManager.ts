import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import type { Logger } from 'pino';
import type { OpenAIService } from '../ai/openai.js';
import type { AppConfig } from '../config.js';
import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import { errorMessage, serializeError } from '../utils/errors.js';
import { Mutex } from '../utils/mutex.js';
import { pcmToWav } from './audioUtils.js';
import { RealtimeTranscriber } from './realtime.js';
import { toFile } from 'openai';

export class VoiceManager {
  private realtimeHealthy = true;
  private closed = false;
  private readonly shutdown = new AbortController();
  private readonly speechMutex = new Mutex();

  constructor(
    private readonly minecraft: MinecraftAgent,
    private readonly openai: OpenAIService,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly realtime: Pick<RealtimeTranscriber, 'transcribe' | 'close'> = new RealtimeTranscriber(openai, config.transcribeModel)
  ) {}

  get enabled(): boolean {
    return !this.closed && this.config.voiceEnabled && this.openai.enabled;
  }

  status() {
    return {
      enabled: this.enabled,
      closed: this.closed,
      transcriptionTransport: this.config.voiceMode !== 'browser' && this.realtimeHealthy ? 'realtime' as const : 'file' as const,
      transcribeModel: this.config.transcribeModel,
      ttsModel: this.config.ttsModel,
      voice: this.config.voice
    };
  }

  async transcribe(pcm: Buffer): Promise<string> {
    this.assertEnabled();
    if (pcm.length === 0) return '';
    if (this.realtimeHealthy) {
      try {
        const transcript = await this.realtime.transcribe(pcm);
        this.assertEnabled();
        this.logger.info({ stage: 'transcription', transport: 'realtime', characters: transcript.length }, 'Voice transcription completed');
        return transcript;
      } catch (error) {
        this.assertEnabled();
        this.realtimeHealthy = false;
        this.realtime.close();
        this.logger.warn({ error: serializeError(error), stage: 'transcription', transport: 'realtime' }, 'Realtime transcription unavailable; using file transcription fallback');
      }
    }
    try {
      const transcript = await this.transcribeFile(pcm);
      this.assertEnabled();
      this.logger.info({ stage: 'transcription', transport: 'file', characters: transcript.length }, 'Voice transcription completed');
      return transcript;
    } catch (error) {
      if (!this.closed) this.logger.warn({ error: serializeError(error), stage: 'transcription', transport: 'file' }, 'Voice transcription failed');
      throw error;
    }
  }

  async speak(text: string, signal?: AbortSignal): Promise<ActionResultLike> {
    const cancellation = signal ? AbortSignal.any([this.shutdown.signal, signal]) : this.shutdown.signal;
    return this.speechMutex.runExclusive(() => this.speakExclusive(text, cancellation));
  }

  /** Browser recordings are mono 48 kHz PCM; upload in memory, without a game voice connection. */
  async transcribeBrowser(pcm: Buffer, requestSignal?: AbortSignal): Promise<string> {
    const signal = requestSignal ? AbortSignal.any([this.shutdown.signal, requestSignal]) : this.shutdown.signal;
    this.assertEnabled();
    signal.throwIfAborted();
    const file = await toFile(pcmToWav(pcm), 'microphone.wav', { type: 'audio/wav' });
    signal.throwIfAborted();
    const result = await this.openai.requireClient().audio.transcriptions.create({
      model: this.config.transcribeModel, file, response_format: 'json'
    }, { signal });
    signal.throwIfAborted();
    this.assertEnabled();
    return result.text.trim();
  }

  /** Generate audio independently of Minecraft playback. Never exposes the API key. */
  async generateSpeech(text: string, requestSignal?: AbortSignal): Promise<Buffer> {
    const signal = requestSignal ? AbortSignal.any([this.shutdown.signal, requestSignal]) : this.shutdown.signal;
    this.assertEnabled();
    signal.throwIfAborted();
    if (!text.trim()) throw new Error('Voice reply is empty');
    const response = await this.openai.requireClient().audio.speech.create({
      model: this.config.ttsModel,
      voice: this.config.voice,
      input: text.slice(0, 2000),
      instructions: 'Speak naturally and conversationally as a person inside Minecraft.',
      response_format: 'mp3'
    }, { signal });
    const audio = Buffer.from(await response.arrayBuffer());
    this.assertEnabled();
    signal.throwIfAborted();
    if (!audio.length) throw new Error('Speech API returned empty audio');
    this.logger.info({ stage: 'tts', model: this.config.ttsModel, bytes: audio.length }, 'Voice speech generated');
    return audio;
  }

  private async speakExclusive(text: string, signal: AbortSignal): Promise<ActionResultLike> {
    if (signal.aborted) return { success: false, stage: 'availability', reason: 'Voice request cancelled' };
    if (!this.enabled || !this.minecraft.speakAudio) return { success: false, stage: 'availability', reason: 'Voice output is unavailable' };
    if (!text.trim()) return { success: false, stage: 'tts', reason: 'Voice reply is empty' };
    const before = this.minecraft.voiceStatus?.();
    if (before && !before.connected) return this.playbackFailure(before.reason ?? 'Minecraft voice chat is not connected');
    let audio: Buffer;
    try {
      audio = await this.generateSpeech(text, signal);
    } catch (error) {
      if (!this.closed && !signal.aborted) this.logger.warn({ error: serializeError(error), stage: 'tts', model: this.config.ttsModel }, 'Voice speech generation failed');
      return { success: false, stage: this.closed || signal.aborted ? 'availability' : 'tts', reason: signal.aborted ? 'Voice request cancelled' : errorMessage(error) };
    }
    const after = this.minecraft.voiceStatus?.();
    if (after && !after.connected) return this.playbackFailure(after.reason ?? 'Minecraft voice chat disconnected during speech generation');
    try {
      const result = await this.minecraft.speakAudio(audio, 'audio/mpeg');
      if (!result.success) return this.playbackFailure(result.reason ?? 'Minecraft voice transport rejected playback');
      if (this.closed || signal.aborted) return { success: false, stage: 'availability', reason: 'Voice request cancelled' };
      this.logger.info({ stage: 'playback', bytes: audio.length }, 'Voice audio sent to Minecraft');
      return result;
    } catch (error) {
      return this.playbackFailure(errorMessage(error), error);
    }
  }

  private playbackFailure(reason: string, error?: unknown): ActionResultLike {
    this.logger.warn({ stage: 'playback', reason: errorMessage(reason), ...(error === undefined ? {} : { error: serializeError(error) }) }, 'Minecraft voice playback failed');
    return { success: false, stage: 'playback', reason: errorMessage(reason) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdown.abort();
    this.realtime.close();
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error(this.closed ? 'Voice manager is closed' : 'Voice AI is disabled');
  }

  private async transcribeFile(pcm: Buffer): Promise<string> {
    const directory = path.join(this.config.dataDir, 'voice', 'incoming');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `utterance-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    try {
      this.assertEnabled();
      await fs.writeFile(file, pcmToWav(pcm));
      this.assertEnabled();
      const stream = createReadStream(file);
      const closed = finished(stream).catch(() => undefined);
      try {
        const transcript = await this.openai.requireClient().audio.transcriptions.create({
          model: this.config.transcribeModel,
          file: stream,
          response_format: 'json'
        }, { signal: this.shutdown.signal });
        return transcript.text.trim();
      } finally {
        stream.destroy();
        await closed;
      }
    } finally {
      await fs.unlink(file).catch(() => undefined);
    }
  }
}

export interface ActionResultLike {
  success: boolean;
  reason?: string;
  stage?: 'availability' | 'tts' | 'playback';
}

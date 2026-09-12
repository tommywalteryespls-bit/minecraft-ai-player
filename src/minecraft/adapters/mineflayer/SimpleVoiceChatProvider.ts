import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import type { Bot } from 'mineflayer';
import type { Logger } from 'pino';
import { redactSecrets, serializeError } from '../../../utils/errors.js';

interface VoiceServerSettings {
  voiceHost: string;
  serverPort: number;
}

interface VoiceSocketClient extends EventEmitter {
  connect(): void;
  close?(): void;
}

interface VoicechatSound {
  channelId?: string;
  /** mineflayer-simplevoice resolves the sender UUID to a Minecraft username. */
  sender?: string;
  data: Buffer;
  distance: number;
  sequenceNumber: bigint;
}

interface VoicechatApi {
  _client?: {
    getPackets(): { secretPacket: EventEmitter };
    getSocketClient(): VoiceSocketClient;
  };
  isConnected(): boolean;
  getPlayer?(username: string): { playerUUID: string } | undefined;
  stopAudio?(): void;
  sendAudio(file: string): Promise<void>;
}

type VoiceBot = Bot & { voicechat?: VoicechatApi };

interface VoicePluginModule {
  plugin: (bot: Bot) => void;
  setLoggingLevel?: (level: number) => void;
}

export interface VoiceUtterance {
  senderId?: string;
  username?: string;
  distance: number;
  pcm: Buffer;
}

export class SimpleVoiceChatProvider {
  private ready = false;
  private buffers = new Map<string, { chunks: Buffer[]; distance: number; timer: NodeJS.Timeout }>();
  private eventBot: EventEmitter | null = null;
  private bot: VoiceBot | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private settingsReceived = false;
  private udpOpened = false;
  private connectionProblem: string | undefined;
  private cleanupHooks: Array<() => void> = [];
  private readonly onConnect = () => {
    this.ready = true;
    this.connectionProblem = undefined;
    this.logger.info('Simple Voice Chat connected');
  };
  private readonly onSound = (data: VoicechatSound) => this.bufferFrame(data);
  private readonly onEnd = () => { void this.detach(); };

  constructor(
    private readonly dataDir: string,
    private readonly logger: Logger,
    private readonly onUtterance: (utterance: VoiceUtterance) => void,
    private readonly loadVoicePlugin: () => VoicePluginModule = () => createRequire(import.meta.url)('mineflayer-simplevoice') as VoicePluginModule,
    private readonly fallbackHostname?: string
  ) {}

  attach(bot: Bot): void {
    if (this.bot) throw new Error('Simple Voice Chat is already attached');
    const loaded = this.loadVoicePlugin();
    loaded.setLoggingLevel?.(4);
    const generation = ++this.generation;
    this.settingsReceived = false;
    this.udpOpened = false;
    this.connectionProblem = undefined;
    this.bot = bot as VoiceBot;
    this.eventBot = bot as unknown as EventEmitter;
    this.eventBot.on('voicechat_connect', this.onConnect);
    this.eventBot.on('voicechat_player_sound', this.onSound);
    this.eventBot.on('end', this.onEnd);
    try {
      // Mineflayer may defer plugin initialization until inject_allowed.
      bot.loadPlugin((pluginBot) => {
        if (this.bot !== pluginBot || this.generation !== generation) return;
        loaded.plugin(pluginBot);
        this.observeHandshake(pluginBot as VoiceBot, generation);
      });
    } catch (error) {
      void this.detach();
      throw error;
    }
  }

  async detach(): Promise<void> {
    this.ready = false;
    this.generation++;
    this.eventBot?.removeListener('voicechat_connect', this.onConnect);
    this.eventBot?.removeListener('voicechat_player_sound', this.onSound);
    this.eventBot?.removeListener('end', this.onEnd);
    this.eventBot = null;
    const bot = this.bot;
    this.bot = null;
    for (const cleanup of this.cleanupHooks.splice(0)) cleanup();
    for (const pending of this.buffers.values()) clearTimeout(pending.timer);
    this.buffers.clear();
    bot?.voicechat?.stopAudio?.();
  }

  isReady(): boolean {
    return this.ready && Boolean(this.bot?.voicechat?.isConnected());
  }

  connectionStatus(): { connected: boolean; reason?: string } {
    if (this.isReady()) return { connected: true };
    if (this.connectionProblem) return { connected: false, reason: this.connectionProblem };
    if (!this.bot) return { connected: false, reason: 'Simple Voice Chat is detached' };
    if (!this.settingsReceived) return { connected: false, reason: 'Waiting for Simple Voice Chat server settings; check that the server has a compatible Simple Voice Chat mod or plugin installed' };
    return {
      connected: false,
      reason: this.udpOpened
        ? 'Simple Voice Chat server settings received, but the UDP voice handshake is incomplete; check the server voice port and UDP connectivity'
        : 'Simple Voice Chat server settings received; waiting for the UDP voice connection'
    };
  }

  private observeHandshake(bot: VoiceBot, generation: number): void {
    const client = bot.voicechat?._client;
    if (!client) return;
    const settingsPacket = client.getPackets().secretPacket;
    const socketClient = client.getSocketClient();
    const isCurrent = () => this.bot === bot && this.generation === generation;
    let endpointProblem: string | undefined;
    const onSettings = (settings: VoiceServerSettings) => {
      if (!isCurrent()) return;
      this.ready = false;
      this.settingsReceived = true;
      this.udpOpened = false;
      this.connectionProblem = undefined;
      endpointProblem = undefined;
      let endpointSource = 'server';
      if (settings.voiceHost === '') {
        const peer = bot._client?.socket?.remoteAddress?.replace(/^::ffff:/i, '');
        const fallback = this.fallbackHostname?.trim();
        const host = peer && isIP(peer) === 4
          ? peer
          : fallback && /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(fallback) ? fallback : undefined;
        if (host) {
          // mineflayer-simplevoice 1.1.1 otherwise sends blank-host servers to localhost.
          settings.voiceHost = host;
          endpointSource = host === peer ? 'minecraft_peer' : 'server_profile';
        } else {
          endpointProblem = 'Simple Voice Chat advertised no hostname and the Minecraft server address could not be resolved for UDP voice';
          this.connectionProblem = endpointProblem;
          this.logger.warn({ stage: 'voice_handshake' }, endpointProblem);
          return;
        }
      }
      // Never log the settings packet: it includes the voice authentication secret.
      const voiceHost = redactSecrets(settings.voiceHost).replace(/[^a-z\d.:_[\]-]/gi, '?').slice(0, 255);
      this.logger.info({ stage: 'voice_handshake', voiceHost, voicePort: settings.serverPort, endpointSource }, 'Simple Voice Chat server settings received');
    };
    const onSocketConnect = () => {
      if (!isCurrent()) return;
      this.udpOpened = true;
      this.logger.info({ stage: 'voice_handshake' }, 'Simple Voice Chat UDP socket opened; waiting for server authentication');
    };
    const onSocketClose = () => {
      if (!isCurrent()) return;
      this.ready = false;
      this.udpOpened = false;
      this.connectionProblem ??= 'Simple Voice Chat UDP connection closed';
    };
    const onSocketError = (error: unknown) => {
      if (!isCurrent()) return;
      this.ready = false;
      this.connectionProblem = 'Simple Voice Chat UDP connection failed; check the advertised voice endpoint and UDP connectivity';
      this.logger.warn({ stage: 'voice_handshake', error: serializeError(error) }, this.connectionProblem);
    };
    const originalConnect = socketClient.connect;
    const guardedConnect = () => {
      if (isCurrent() && !endpointProblem) originalConnect.call(socketClient);
    };
    socketClient.connect = guardedConnect;
    settingsPacket.prependListener('packet', onSettings);
    socketClient.on('connect', onSocketConnect);
    socketClient.on('close', onSocketClose);
    socketClient.on('error', onSocketError);
    this.cleanupHooks.push(() => {
      settingsPacket.removeListener('packet', onSettings);
      socketClient.removeListener('connect', onSocketConnect);
      socketClient.removeListener('close', onSocketClose);
      socketClient.removeListener('error', onSocketError);
      if (socketClient.connect === guardedConnect) socketClient.connect = originalConnect;
    });
  }

  async send(bot: Bot, audio: Buffer, mimeType = 'audio/mpeg'): Promise<void> {
    const pending = this.sendQueue.then(() => this.sendFile(bot, audio, mimeType));
    // A failed transmission must not prevent the next reply from being sent.
    this.sendQueue = pending.catch(() => undefined);
    await pending;
  }

  private async sendFile(bot: Bot, audio: Buffer, mimeType: string): Promise<void> {
    const voicechat = (bot as VoiceBot).voicechat;
    if (!this.isReady() || this.bot !== bot || !voicechat) throw new Error('Simple Voice Chat is not connected');
    const extension = mimeType.includes('wav') ? 'wav' : 'mp3';
    const directory = path.join(this.dataDir, 'voice', 'outgoing');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `speech-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`);
    try {
      await fs.writeFile(file, audio);
      // Version 1.1.1 resolves only after conversion and audio playback finish.
      await voicechat.sendAudio(file);
      if (!this.isReady() || this.bot !== bot) throw new Error('Simple Voice Chat disconnected during playback');
    } finally {
      await fs.unlink(file).catch(() => undefined);
    }
  }

  private bufferFrame(data: VoicechatSound): void {
    if (!this.isReady() || !Buffer.isBuffer(data.data) || data.data.length === 0) return;
    const username = data.sender;
    const player = username ? Object.values(this.bot?.players ?? {}).find((candidate) => candidate.username.toLowerCase() === username.toLowerCase()) : undefined;
    const senderId = username ? this.bot?.voicechat?.getPlayer?.(username)?.playerUUID ?? player?.uuid ?? player?.entity?.uuid : undefined;
    // Unresolved voice channels must not combine different players into one utterance.
    const key = username ?? data.channelId ?? 'unknown';
    const existing = this.buffers.get(key);
    if (existing) clearTimeout(existing.timer);
    const chunks = existing?.chunks ?? [];
    chunks.push(data.data);
    const timer = setTimeout(() => {
      const complete = this.buffers.get(key);
      this.buffers.delete(key);
      if (!complete) return;
      if (!this.isReady()) return;
      this.onUtterance({ senderId, username, distance: complete.distance, pcm: Buffer.concat(complete.chunks) });
    }, 850);
    timer.unref();
    this.buffers.set(key, { chunks, distance: data.distance, timer });
  }
}

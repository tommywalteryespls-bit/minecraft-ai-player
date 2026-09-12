import path from 'node:path';
import type { AppConfig } from '../config.js';
import { MineflayerAdapter } from '../minecraft/adapters/mineflayer/MineflayerAdapter.js';
import { TestMinecraftAgent } from '../minecraft/adapters/test/TestMinecraftAgent.js';
import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import { ServerProfileLoader } from '../minecraft/serverProfiles/profileLoader.js';
import type { ServerProfile } from '../minecraft/serverProfiles/profileTypes.js';
import { MemoryDatabase } from '../memory/database.js';
import { MemoryManager } from '../memory/memoryManager.js';
import { ProfileCommandAdapter } from '../server/adapters/ProfileCommandAdapter.js';
import { capabilitiesFor } from '../server/serverCapabilities.js';
import type { Loggers } from '../utils/logger.js';
import { retryWithBackoff } from './lifecycle.js';
import { ActionScheduler } from './actionScheduler.js';
import { ReflexController } from './reflexes.js';
import { OpenAIService } from '../ai/openai.js';
import { ContextBuilder } from '../ai/contextBuilder.js';
import { ToolExecutor } from '../ai/toolExecutor.js';
import { Planner } from '../ai/planner.js';
import { VoiceManager } from '../voice/voiceManager.js';
import { JournalService } from '../memory/journal.js';
import { ExperimentTracker } from '../memory/experiment.js';
import { AutonomousAgent } from './agent.js';
import { BrowserVoiceServer } from '../voice/browserServer.js';
import { FabricAdapter } from '../minecraft/adapters/fabric/FabricAdapter.js';
import { ensureFabricToken } from '../utils/fabricConfig.js';

export class AgentApplication {
  readonly profiles: ServerProfileLoader;
  readonly memory: MemoryManager;
  private readonly openai: OpenAIService;
  private minecraft: MinecraftAgent | null = null;
  private agent: AutonomousAgent | null = null;
  private profile: ServerProfile | null = null;
  private disconnectWatcher: (() => void) | null = null;
  private switching = false;
  private reconnecting = false;
  private shuttingDown = false;
  private browserVoice: BrowserVoiceServer | null = null;

  constructor(
    readonly config: AppConfig,
    private readonly loggers: Loggers
  ) {
    this.profiles = new ServerProfileLoader(config.serversDir);
    this.memory = new MemoryManager(new MemoryDatabase(path.join(config.dataDir, 'memory.sqlite')), config.dataDir, config.memoryEnabled);
    this.openai = new OpenAIService(config);
    this.initializeIdentity();
  }

  get currentServerId(): string | null {
    return this.profile?.controller === 'fabric' ? this.minecraft?.serverId ?? this.profile.id : this.profile?.id ?? null;
  }

  get currentAgent(): AutonomousAgent | null {
    return this.agent;
  }

  get browserVoiceUrl(): string | null { return this.browserVoice?.url ?? null; }
  get activeVoiceMode(): 'browser' | 'minecraft' {
    return this.minecraft?.controlStatus ? 'browser' : this.config.voiceMode ?? 'minecraft';
  }

  async startBrowserVoice(force = false): Promise<void> {
    if ((!force && this.config.voiceMode !== 'browser') || this.browserVoice) return;
    const server = new BrowserVoiceServer({
      status: () => {
        const control = this.minecraft?.controlStatus?.();
        const owner = control?.username ?? this.config.owner;
        return {
        aiName: this.config.aiName, owner,
        ownerValid: /^[A-Za-z0-9_]{1,16}$/.test(owner.trim()),
        enabled: this.config.voiceEnabled && this.openai.enabled,
        controlEnabled: control?.enabled ?? true,
        availabilityReason: !this.config.voiceEnabled || !this.openai.enabled ? 'Voice is disabled or OPENAI_API_KEY is not configured.' : control?.reason,
        controller: this.profile?.controller,
        supportsInterrupt: this.profile?.controller === 'fabric' && this.config.fabricUnrestricted === true,
        connected: Boolean(this.minecraft?.connected && this.agent?.state.running),
        serverId: this.currentServerId, plannerModel: this.config.openaiModel,
        transcribeModel: this.config.transcribeModel, ttsModel: this.config.ttsModel, voice: this.config.voice
      }; },
      converse: async (pcm, signal) => this.agent
        ? this.agent.converseFromBrowser(pcm, signal)
        : { success: false, stage: 'availability', reason: 'Connect the bot to Minecraft first' },
      interrupt: async (pcm, signal) => this.agent
        ? this.agent.interruptFromBrowser(pcm, signal)
        : { success: false, stage: 'availability', reason: 'Connect the bot to Minecraft first' },
      stop: async () => { await this.agent?.stopBrowserTask(); }
    }, { unlimitedTurns: () => this.profile?.controller === 'fabric' && this.config.fabricUnrestricted === true });
    const url = await server.listen(this.config.browserVoicePort ?? 3001);
    this.browserVoice = server;
    this.loggers.agent.info({ url }, 'Local browser voice panel ready; open in Chrome or Edge');
    console.log(`Browser voice: ${url} (open in Chrome or Edge; microphone starts only when you click)`);
  }

  async connect(serverId: string): Promise<void> {
    if (this.switching) throw new Error('A server switch is already in progress');
    this.switching = true;
    const previous = this.profile?.id ?? null;
    try {
      await this.disconnect();
      const profile = await this.profiles.load(serverId);
      const fabric = profile.controller === 'fabric' && !this.config.testMode;
      if (!fabric && this.config.voiceMode !== 'browser' && this.browserVoice) {
        await this.browserVoice.close();
        this.browserVoice = null;
      }
      if (fabric && !this.browserVoice) {
        await this.startBrowserVoice(true);
      }
      const controllerConfig = fabric ? { ...this.config, fabricBridgeToken: await ensureFabricToken(this.config), autonomousEnabled: false, reflexesEnabled: false, voiceMode: 'browser' as const } : this.config;
      const minecraft: MinecraftAgent = this.config.testMode || profile.controller === 'test'
        ? new TestMinecraftAgent(profile.id)
        : fabric ? new FabricAdapter(profile, controllerConfig, this.loggers.servers.child({ serverId: profile.id }))
        : new MineflayerAdapter(profile, this.config, this.loggers.servers.child({ serverId: profile.id }));
      const capabilities = capabilitiesFor(profile);
      const features = new ProfileCommandAdapter(profile, minecraft);
      const scheduler = new ActionScheduler(minecraft, this.loggers.actions.child({ serverId: profile.id }));
      const context = new ContextBuilder(minecraft, this.memory, capabilities, fabric && controllerConfig.fabricUnrestricted === true);
      const executor = new ToolExecutor(minecraft, this.memory, scheduler, capabilities, features, controllerConfig);
      const planner = new Planner(this.openai, context, executor, this.loggers.agent.child({ serverId: profile.id }), this.config.aiName, this.config.owner, this.config.openaiModel, this.config.maxToolRounds, fabric && controllerConfig.fabricUnrestricted === true);
      const voice = new VoiceManager(minecraft, this.openai, controllerConfig, this.loggers.conversations.child({ serverId: profile.id }));
      const journal = new JournalService(this.memory);
      const experiment = new ExperimentTracker(this.memory, this.openai, this.config.dataDir, this.config.openaiModel, this.loggers.agent);
      const reflexes = new ReflexController(minecraft, scheduler, this.loggers.actions, controllerConfig.reflexesEnabled);
      const agent = new AutonomousAgent(minecraft, planner, this.memory, journal, experiment, voice, scheduler, reflexes, controllerConfig, this.loggers.agent, profile.behavior.autonomous, fabric);
      this.profile = profile;
      this.minecraft = minecraft;
      this.agent = agent;
      this.disconnectWatcher = minecraft.subscribe((event) => {
        if (event.type === 'SERVER_DISCONNECTED' && event.data?.intentional !== true && !this.switching && !this.reconnecting && !this.shuttingDown) {
          void this.reconnect().catch((error) => this.loggers.errors.error({ serverId, error }, 'Reconnect attempts exhausted'));
        }
      });
      await this.connectMinecraft(profile, minecraft);
      agent.start();
      this.memory.recordEvent({ serverId, type: previous ? 'SERVER_CHANGED' : 'SERVER_CONNECTED', summary: previous ? `Changed server from ${previous} to ${serverId}` : `Connected to ${serverId}`, importance: 0.8 });
      this.loggers.servers.info({ serverId, host: profile.host, port: profile.port }, fabric ? 'Fabric bridge listening; join your world in Minecraft, then press F8 to enable voice control' : 'Connected');
    } finally {
      this.switching = false;
    }
  }

  async disconnect(): Promise<void> {
    this.disconnectWatcher?.();
    this.disconnectWatcher = null;
    const agent = this.agent;
    const minecraft = this.minecraft;
    this.agent = null;
    this.minecraft = null;
    this.profile = null;
    if (agent) await agent.stop();
    if (minecraft) await minecraft.disconnect('Switching or shutting down').catch((error) => this.loggers.errors.warn({ error }, 'Clean disconnect reported an error'));
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.browserVoice?.close();
    this.browserVoice = null;
    await this.disconnect();
    this.memory.close();
    this.loggers.agent.info('Shutdown complete');
  }

  async state(): Promise<Record<string, unknown>> {
    return this.agent?.status() ?? { connected: false, serverId: null };
  }

  private async reconnect(): Promise<void> {
    const profile = this.profile;
    const minecraft = this.minecraft;
    if (!profile || !minecraft || !profile.reconnect.enabled) return;
    const attempts = profile.reconnect.maxAttempts ?? this.config.reconnectMaxAttempts;
    if (attempts === 0) return;
    this.reconnecting = true;
    try {
      await retryWithBackoff(() => minecraft.connect(), {
        attempts,
        baseDelayMs: profile.reconnect.baseDelayMs ?? this.config.reconnectBaseDelayMs,
        label: `Reconnect to ${profile.id}`,
        logger: this.loggers.servers
      });
    } finally {
      this.reconnecting = false;
    }
  }

  private async connectMinecraft(profile: ServerProfile, minecraft: MinecraftAgent): Promise<void> {
    await retryWithBackoff(() => minecraft.connect(), {
      attempts: Math.max(1, profile.reconnect.maxAttempts ?? this.config.reconnectMaxAttempts),
      baseDelayMs: profile.reconnect.baseDelayMs ?? this.config.reconnectBaseDelayMs,
      label: `Connect to ${profile.id}`,
      logger: this.loggers.servers
    });
  }

  private initializeIdentity(): void {
    const identity = this.memory.getIdentity();
    if (!identity.name) this.memory.setIdentity('name', this.config.aiName);
    if (this.config.owner && !identity.owner) this.memory.setIdentity('owner', this.config.owner);
    if (!identity.createdAt) this.memory.setIdentity('createdAt', new Date().toISOString());
  }
}

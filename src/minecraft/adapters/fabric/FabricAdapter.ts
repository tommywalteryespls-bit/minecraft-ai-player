import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Logger } from 'pino';
import type { AppConfig } from '../../../config.js';
import type { MinecraftAgent } from '../../MinecraftAgent.js';
import type { ServerProfile } from '../../serverProfiles/profileTypes.js';
import type {
  ActionResult, ContainerRequest, InventoryState, MineRequest, MinecraftEvent, MinecraftEventListener,
  MoveOptions, PlaceBlockRequest, PlayerControlRequest, Position, SmeltRequest, WorldState
} from '../../types.js';
import {
  FABRIC_ACTIONS, FABRIC_BRIDGE_PROTOCOL_VERSION, FABRIC_MAX_PAYLOAD_BYTES, FABRIC_STATE_MAX_AGE_MS,
  FabricBridgeMessageSchema, FabricPlayerControlSchema, FabricUnrestrictedPlayerControlSchema, type FabricBridgeMessage
} from './protocol.js';
import { FabricSkills } from './FabricSkills.js';
import { smeltingSources } from '../../../skills/recipeCatalog.js';
import { handleFabricHealth, managedBackendReady, takeManagedServer } from '../../../core/managedLifetime.js';

type Session = Extract<FabricBridgeMessage, { type: 'hello' }>;
type PendingAction = {
  action: string; sessionId: string; controlEpoch: number;
  timer: ReturnType<typeof setTimeout> | undefined; resolve: (result: ActionResult) => void;
};

/** Local controller for the already logged-in Fabric player. No Minecraft login or remote listener. */
export class FabricAdapter implements MinecraftAgent {
  private server: Server | null = null;
  private webSockets: WebSocketServer | null = null;
  private listening: Promise<void> | null = null;
  private client: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private helloDeadline: ReturnType<typeof setTimeout> | null = null;
  private session: Session | null = null;
  private snapshot: WorldState | null = null;
  private snapshotAt = 0;
  private worldAnnounced = false;
  private controlReason = 'Start Minecraft with the Fabric mod and join a world';
  private readonly pending = new Map<string, PendingAction>();
  private readonly listeners = new Set<MinecraftEventListener>();
  private skillAbort = new AbortController();
  private skills: FabricSkills | null = null;
  private get hasSkills(): boolean { return Boolean(this.session?.capabilities?.includes('gameplay-skills-v1')); }
  private get gameplay(): FabricSkills { return this.skills ??= new FabricSkills((action, args, timeout) => this.request(action, args, timeout), () => this.getWorldState()); }

  constructor(private readonly profile: ServerProfile, private readonly config: AppConfig, private readonly logger: Logger) {}

  get serverId(): string {
    return this.session ? `${this.profile.id}-${createHash('sha256').update(this.session.worldId).digest('hex').slice(0, 12)}` : this.profile.id;
  }
  get connected(): boolean {
    return Boolean(this.client?.readyState === WebSocket.OPEN && this.session && this.snapshot?.connected &&
      Date.now() - this.snapshotAt < FABRIC_STATE_MAX_AGE_MS);
  }
  get supportedActions(): readonly string[] { return [...(this.session?.supportedActions ?? []).filter((name) =>
    !['scan_search_area', 'base_search_step'].includes(name) || this.session?.capabilities?.includes('base-search-v1')), ...(this.hasSkills ? ['collect_resource'] : [])]; }
  private get policySupported(): boolean { return !this.config.fabricUnrestricted || Boolean(this.session?.capabilities?.includes('unrestricted-v1')); }
  controlStatus(): { enabled: boolean; reason?: string; username?: string; worldId?: string } {
    const enabled = this.connected && this.policySupported && Boolean(this.session?.controlsEnabled);
    return { enabled, reason: enabled ? undefined : !this.policySupported ? 'Update the Fabric mod to enable unrestricted control' : this.connected ? this.controlReason : 'Waiting for a fresh Fabric world connection',
      username: this.session?.username, worldId: this.session?.worldId };
  }

  connect(): Promise<void> {
    if (this.listening) return this.listening;
    const token = this.config.fabricBridgeToken ?? '';
    if (!/^[a-fA-F0-9]{64}$/.test(token)) return Promise.reject(new Error('Fabric bridge requires a 64-character hexadecimal pairing token'));
    const port = this.config.fabricBridgePort ?? 8765;
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new Error('Invalid Fabric bridge port'));
    const server = takeManagedServer('bridge', port) ?? createServer();
    server.on('request', (request, response) => {
      if (!handleFabricHealth(request, response, server, { token, voicePort: this.config.browserVoicePort ?? 3001, ready: managedBackendReady() })) {
        response.writeHead(404); response.end();
      }
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: FABRIC_MAX_PAYLOAD_BYTES, perMessageDeflate: false });
    this.server = server; this.webSockets = sockets;
    server.on('upgrade', (request, socket, head) => {
      const address = server.address();
      const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
      const header = request.headers.authorization ?? '';
      const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
      const authenticated = /^[a-fA-F0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
      if (!managedBackendReady() || this.server !== server || request.url !== '/astra' || request.headers.host !== expectedHost ||
          Object.prototype.hasOwnProperty.call(request.headers, 'origin') || !authenticated || this.client) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      sockets.handleUpgrade(request, socket, head, (client) => this.accept(client));
    });
    server.on('error', (error) => this.logger.error({ error }, 'Fabric bridge listener failed'));
    this.listening = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server = null; this.webSockets = null; this.listening = null; sockets.close(); reject(error); };
      server.once('error', onError);
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        this.logger.info({ port: typeof address === 'object' ? address?.port : port }, 'Fabric bridge listening on localhost; waiting for Minecraft');
        this.heartbeat = setInterval(() => {
          this.send({ type: 'heartbeat' });
          if (this.snapshot && Date.now() - this.snapshotAt >= FABRIC_STATE_MAX_AGE_MS) this.dropClient('Fabric world snapshot expired');
        }, 1000);
        this.heartbeat.unref(); resolve();
      };
      if (server.listening) onListening(); else server.listen(port, '127.0.0.1', onListening);
    });
    return this.listening;
  }

  async disconnect(reason = 'Controller shutting down'): Promise<void> {
    if (this.listening) await this.listening.catch(() => {});
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.dropClient(reason);
    const server = this.server, sockets = this.webSockets;
    this.server = null; this.webSockets = null; this.listening = null;
    await Promise.all([
      new Promise<void>((resolve) => { if (server?.listening) server.close(() => resolve()); else resolve(); }),
      new Promise<void>((resolve) => { if (sockets) sockets.close(() => resolve()); else resolve(); })
    ]);
  }
  subscribe(listener: MinecraftEventListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async getWorldState(): Promise<WorldState> {
    if (!this.connected || !this.snapshot) throw new Error('No fresh Fabric world snapshot; join a world in Minecraft');
    return structuredClone(this.snapshot);
  }
  async getInventory(): Promise<InventoryState> { return (await this.getWorldState()).inventory; }
  async cancelCurrentAction(reason = 'Action cancelled'): Promise<void> {
    this.skillAbort.abort(); this.skillAbort = new AbortController();
    if (this.session) this.send({ type: 'cancel', sessionId: this.session.sessionId, reason });
    this.failPending(reason);
  }

  moveTo(position: Position, options?: MoveOptions): Promise<ActionResult> { return this.request('move_to', { position, timeout_ms: options?.timeoutMs, sprint: options?.sprint, can_dig: options?.canDig }, options?.timeoutMs); }
  scanSearchArea(radius = 4): Promise<ActionResult> {
    if (!this.supportedActions.includes('scan_search_area')) return Promise.resolve(this.failure('scan_search_area', 'Install the base-search Fabric mod update'));
    return this.request('scan_search_area', { radius });
  }
  baseSearchStep(position: Position): Promise<ActionResult> {
    if (!this.supportedActions.includes('base_search_step')) return Promise.resolve(this.failure('base_search_step', 'Install the base-search Fabric mod update'));
    return this.request('base_search_step', { position });
  }
  moveNear(position: Position, radius: number, options?: MoveOptions): Promise<ActionResult> { return this.request('move_near', { position, radius, timeout_ms: options?.timeoutMs, sprint: options?.sprint, can_dig: options?.canDig }, options?.timeoutMs); }
  followPlayer(username: string): Promise<ActionResult> { return this.request('follow_player', { username }); }
  async stopFollowing(): Promise<ActionResult> { await this.cancelCurrentAction('Stop requested'); return this.request('stop_following', {}, undefined, true); }
  lookAt(target: Position): Promise<ActionResult> { return this.request('look_at', { target }); }
  findBlock(block: string, radius?: number): Promise<ActionResult> { return this.request('find_block', { block, radius }); }
  mineBlock(request: MineRequest): Promise<ActionResult> { return this.hasSkills ? this.gameplay.mine(request, this.skillAbort.signal) : this.request('mine_block', { ...request }); }
  collectResource(resource: string, amount: number): Promise<ActionResult> { return this.hasSkills ? this.gameplay.collect(resource, amount, this.skillAbort.signal) : this.request('collect_resource', { resource, amount }); }
  pickupItems(radius?: number): Promise<ActionResult> { return this.request('pickup_items', { radius }); }
  craftItem(item: string, amount: number): Promise<ActionResult> { return this.hasSkills ? this.gameplay.craft(item, amount, this.skillAbort.signal) : this.request('craft_item', { item, amount }); }
  equipItem(item: string, destination?: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'): Promise<ActionResult> { return this.request('equip_item', { item, destination }); }
  eatBestFood(): Promise<ActionResult> { return this.request('eat_best_food', {}); }
  attackEntity(entityId: string): Promise<ActionResult> { return this.request('attack_entity', { entity_id: entityId }); }
  attackNearestHostile(): Promise<ActionResult> { return this.request('attack_nearest_hostile', {}); }
  fleeFrom(threatId: string): Promise<ActionResult> { return this.request('flee', { threat_id: threatId }); }
  placeBlock(request: PlaceBlockRequest): Promise<ActionResult> { return this.request('place_block', { ...request }); }
  sleep(): Promise<ActionResult> { return this.request('sleep', {}); }
  inspectContainer(request: ContainerRequest): Promise<ActionResult> { return this.request('inspect_container', { ...request }); }
  depositItem(request: ContainerRequest): Promise<ActionResult> { return this.request('deposit_item', { ...request }); }
  withdrawItem(request: ContainerRequest): Promise<ActionResult> { return this.request('withdraw_item', { ...request }); }
  smeltItem(request: SmeltRequest): Promise<ActionResult> {
    const output = Object.entries(smeltingSources).find(([, input]) => input === request.input)?.[0];
    if (this.hasSkills && !output) return Promise.resolve(this.failure('smelt_item', 'No supported smelting recipe for that input'));
    return this.request('smelt_item', { input: request.input, output, fuel: request.fuel, amount: request.amount, furnace_position: request.furnacePosition });
  }
  sayText(message: string): Promise<ActionResult> {
    if (!message.trim() || message.trimStart().startsWith('/') || /[\r\n]/.test(message) || message.length > 256) return Promise.resolve(this.failure('say', 'Only a single plain chat message of at most 256 characters is allowed'));
    return this.request('say', { message });
  }
  async executeServerCommand(_command: string): Promise<ActionResult> { return this.failure('execute_server_command', 'Server command execution is disabled for the Fabric player'); }
  async controlPlayer(request: PlayerControlRequest): Promise<ActionResult> {
    const parsed = (this.config.fabricUnrestricted ? FabricUnrestrictedPlayerControlSchema : FabricPlayerControlSchema).safeParse(request);
    if (!parsed.success) return this.failure('control_player', 'Invalid player control arguments for the configured mode');
    if (parsed.data.command === 'stop') await this.cancelCurrentAction('Stop requested');
    return this.request('control_player', parsed.data, undefined, parsed.data.command === 'stop');
  }

  private accept(client: WebSocket): void {
    this.client = client;
    this.helloDeadline = setTimeout(() => { if (this.client === client && !this.snapshot) this.dropClient('Fabric handshake timed out'); }, 5000);
    this.helloDeadline.unref();
    client.on('message', (data: RawData, binary: boolean) => {
      if (this.client !== client) return;
      if (binary) { this.dropClient('Binary bridge messages are not supported'); return; }
      try {
        const parsed = FabricBridgeMessageSchema.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) { this.dropClient('Invalid Fabric bridge message'); return; }
        this.receive(parsed.data);
      } catch { this.dropClient('Malformed Fabric bridge JSON'); }
    });
    client.on('error', (error: Error) => { this.logger.warn({ error }, 'Fabric bridge socket error'); if (this.client === client) this.dropClient('Fabric bridge socket error'); });
    client.on('close', () => { if (this.client === client) this.dropClient('Fabric client disconnected'); });
  }

  private receive(message: FabricBridgeMessage): void {
    if (message.type === 'hello') {
      if (this.session) this.endSession('Fabric world changed');
      this.session = { ...message, supportedActions: message.supportedActions.filter((action) => (FABRIC_ACTIONS as readonly string[]).includes(action)) };
      this.controlReason = message.controlsEnabled ? '' : 'Voice control is disarmed; enable it inside Minecraft';
      this.send({ type: 'welcome', protocolVersion: FABRIC_BRIDGE_PROTOCOL_VERSION, sessionId: message.sessionId,
        unrestricted: Boolean(this.config.fabricUnrestricted && this.policySupported) }); return;
    }
    const session = this.session;
    if (!session || message.sessionId !== session.sessionId) return;
    if (message.type === 'session_end') { this.endSession(message.reason ?? 'Left Minecraft world'); return; }
    if (message.type === 'result') {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.sessionId !== session.sessionId || pending.controlEpoch !== session.controlEpoch) return;
      clearTimeout(pending.timer); this.pending.delete(message.requestId);
      pending.resolve({ ...message.result, action: pending.action }); return;
    }
    const enabled = message.type === 'state' ? message.controlsEnabled : message.enabled;
    if (message.controlEpoch < session.controlEpoch || (message.controlEpoch === session.controlEpoch && enabled !== session.controlsEnabled)) return;
    if (message.controlEpoch > session.controlEpoch) {
      void this.cancelCurrentAction('Fabric control epoch changed');
      session.controlEpoch = message.controlEpoch; session.controlsEnabled = enabled;
      this.controlReason = enabled ? '' : message.type === 'control' ? message.reason ?? 'Voice control disabled in Minecraft' : 'Voice control disabled in Minecraft';
      if (!enabled) this.emit({ type: 'CONTROL_DISABLED', message: this.controlReason });
    }
    if (message.type === 'control') return;
    if (!message.state.connected) { this.endSession('Minecraft world is not connected'); return; }
    this.snapshot = { ...message.state, serverId: this.serverId, targetBlock: message.state.targetBlock ?? undefined };
    this.snapshotAt = Date.now();
    if (this.helloDeadline) clearTimeout(this.helloDeadline);
    this.helloDeadline = null;
    if (!this.worldAnnounced) {
      this.worldAnnounced = true;
      this.emit({ type: 'SERVER_CONNECTED', username: session.username, position: this.snapshot.position });
    }
  }

  private request(action: string, args: Record<string, unknown>, timeoutMs?: number, stop = false): Promise<ActionResult> {
    const session = this.session;
    if (!session || this.client?.readyState !== WebSocket.OPEN) return Promise.resolve(this.failure(action, 'Fabric client is not connected'));
    if (!stop && !this.connected) return Promise.resolve(this.failure(action, 'Fabric world state is stale or unavailable'));
    if (!stop && !session.controlsEnabled) return Promise.resolve(this.failure(action, this.controlReason));
    if (!stop && !this.policySupported) return Promise.resolve(this.failure(action, 'Update the Fabric mod to enable unrestricted control'));
    if (!session.supportedActions.includes(action)) return Promise.resolve(this.failure(action, `The installed Fabric mod does not support ${action}`));
    if (this.pending.size >= 32) return Promise.resolve(this.failure(action, 'Too many pending Fabric actions'));
    if ((!this.profile.behavior.allowCombat && ['attack_entity', 'attack_nearest_hostile'].includes(action)) ||
        (!this.profile.behavior.allowBlockBreaking && (['mine_block', 'collect_resource', 'base_search_step'].includes(action) || args.can_dig === true)) ||
        (!this.profile.behavior.allowBlockPlacement && action === 'place_block') ||
        (action === 'control_player' && ((!this.profile.behavior.allowCombat && args.command === 'attack') ||
        (!this.profile.behavior.allowBlockBreaking && args.command === 'mine_target') ||
        (!this.profile.behavior.allowBlockPlacement && args.command === 'use')))) return Promise.resolve(this.failure(action, 'This action is disabled by the server profile'));
    if (['craft_item', 'smelt_item'].includes(action)) args = { ...args, allow_place: this.profile.behavior.allowBlockPlacement };
    const requestedTimeout = timeoutMs ?? (this.config.fabricUnrestricted ? 0 : this.config.actionTimeoutMs);
    const boundedTimeout = this.config.fabricUnrestricted
      ? Math.max(0, Math.min(2_147_483_647, Number.isFinite(requestedTimeout) ? requestedTimeout : 0))
      : Math.max(100, Math.min(60_000, Number.isFinite(requestedTimeout) ? requestedTimeout : 30_000));
    const requestId = randomUUID();
    return new Promise<ActionResult>((resolve) => {
      const timer = boundedTimeout === 0 ? undefined : setTimeout(() => {
        this.pending.delete(requestId);
        this.send({ type: 'cancel', sessionId: session.sessionId, requestId, reason: 'Action timed out' });
        resolve(this.failure(action, 'Fabric action timed out'));
      }, boundedTimeout);
      this.pending.set(requestId, { action, sessionId: session.sessionId, controlEpoch: session.controlEpoch, timer, resolve });
      if (!this.send({ type: 'action', requestId, sessionId: session.sessionId, controlEpoch: session.controlEpoch, action, arguments: args, timeoutMs: boundedTimeout })) {
        clearTimeout(timer); this.pending.delete(requestId); resolve(this.failure(action, 'Could not send action to Fabric'));
      }
    });
  }
  private send(message: Record<string, unknown>): boolean {
    if (this.client?.readyState !== WebSocket.OPEN) return false;
    try { this.client.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  private failPending(reason: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(this.failure(pending.action, reason)); }
    this.pending.clear();
  }
  private endSession(reason: string): void {
    const existed = Boolean(this.session);
    void this.cancelCurrentAction(reason);
    // Capture the old world's ID before clearing the session, keeping journals world-scoped.
    if (existed) this.emit({ type: 'SERVER_DISCONNECTED', message: reason, data: { intentional: true } });
    this.session = null; this.snapshot = null; this.snapshotAt = 0; this.worldAnnounced = false; this.controlReason = reason;
  }
  private dropClient(reason: string): void {
    this.endSession(reason);
    if (this.helloDeadline) clearTimeout(this.helloDeadline);
    this.helloDeadline = null;
    const client = this.client; this.client = null; client?.terminate();
  }
  private failure(action: string, reason: string): ActionResult { return { success: false, action, reason }; }
  private emit(event: Omit<MinecraftEvent, 'serverId' | 'timestamp'>): void {
    const complete: MinecraftEvent = { ...event, serverId: this.serverId, timestamp: new Date().toISOString() };
    for (const listener of this.listeners) Promise.resolve().then(() => listener(complete)).catch((error) => this.logger.error({ error }, 'Fabric event listener failed'));
  }
}

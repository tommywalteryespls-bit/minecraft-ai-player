import { timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export const FABRIC_BACKEND_APP = 'astra-fabric-backend';
const PROTOCOL_VERSION = 2;
type Endpoint = { bridgePort: number; voicePort: number; token: string };
type Reservation = { bridge: Server; voice: Server; ready: boolean; taken: Set<string>; close(): Promise<void> };
let managedReservation: Reservation | undefined;

/** Read-only identity probe. It never opens/replaces a Minecraft WebSocket session. */
export function handleFabricHealth(req: IncomingMessage, res: ServerResponse, server: Server,
  settings: { token: string; voicePort: number; ready: boolean }): boolean {
  if (req.url !== '/astra/health') return false;
  const address = server.address();
  const host = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
  const supplied = req.headers.authorization?.slice(0, 7) === 'Bearer ' ? req.headers.authorization.slice(7) : '';
  const authenticated = /^[a-fA-F0-9]{64}$/.test(supplied) && /^[a-fA-F0-9]{64}$/.test(settings.token) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(settings.token));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'close');
  if (req.method !== 'GET' || req.headers.host !== host || req.headers.origin !== undefined || !authenticated) {
    res.writeHead(403); res.end(); return true;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ app: FABRIC_BACKEND_APP, protocolVersion: PROTOCOL_VERSION,
    voicePort: settings.voicePort, ready: settings.ready }));
  return true;
}

export function managedBackendReady(): boolean { return managedReservation?.ready ?? true; }

/** Adopt an already-bound socket; there is deliberately no close/rebind race. */
export function takeManagedServer(kind: 'bridge' | 'voice', port: number): Server | undefined {
  const server = managedReservation?.[kind];
  if (!server || managedReservation?.taken.has(kind)) return undefined;
  const address = server.address();
  if (!address || typeof address === 'string' || address.port !== port) throw new Error('Managed backend port configuration changed during startup');
  managedReservation?.taken.add(kind);
  server.removeAllListeners('request');
  server.removeAllListeners('upgrade');
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve()); server.closeAllConnections();
  });
}

function probe(settings: Endpoint, signal: AbortSignal): Promise<'absent' | 'starting' | 'ready'> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: settings.bridgePort, path: '/astra/health', method: 'GET',
      agent: false, signal, headers: { Authorization: `Bearer ${settings.token}` }, timeout: 700 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; if (body.length > 2048) req.destroy(new Error('Unrecognized service on the Fabric bridge port')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const health = JSON.parse(body) as Record<string, unknown>;
          if (res.statusCode !== 200 || health.app !== FABRIC_BACKEND_APP || health.protocolVersion !== PROTOCOL_VERSION ||
            health.voicePort !== settings.voicePort || typeof health.ready !== 'boolean') throw new Error();
          resolve(health.ready ? 'ready' : 'starting');
        } catch { reject(new Error('Fabric bridge port is occupied by an incompatible or differently paired backend; nothing was stopped')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Fabric bridge health check timed out; nothing was stopped')));
    req.on('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve('absent') : reject(error));
    req.end();
  });
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

/** The OS owns the lock: a crash automatically releases both sockets, with no stale PID files to delete. */
export async function reserveManagedPorts(settings: Endpoint, signal: AbortSignal, waitMs = 10_000): Promise<Reservation | null> {
  if (!/^[a-f0-9]{64}$/.test(settings.token)) throw new Error('Run Setup Fabric Voice once to install valid local pairing');
  if (![settings.bridgePort, settings.voicePort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535) ||
      settings.bridgePort === settings.voicePort) throw new Error('Fabric bridge and browser voice require different valid localhost ports');
  const deadline = Date.now() + waitMs;
  while (true) {
    signal.throwIfAborted();
    const existing = await probe(settings, signal);
    signal.throwIfAborted();
    if (existing === 'ready') return null;
    if (existing === 'absent') {
      let current: Reservation | undefined;
      const bridge = createServer((req, res) => {
        if (!handleFabricHealth(req, res, bridge, { token: settings.token, voicePort: settings.voicePort, ready: current?.ready ?? false })) {
          res.writeHead(503, { Connection: 'close' }); res.end();
        }
      });
      bridge.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
      const voice = createServer((_req, res) => { res.writeHead(503, { Connection: 'close' }); res.end('Astra backend is starting'); });
      try {
        await listen(bridge, settings.bridgePort);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        // Another launcher won the atomic bind. Authenticate its ready response below.
        if (Date.now() >= deadline) throw new Error('Another Fabric backend did not become ready; nothing was stopped');
        await delay(100, undefined, { signal }); continue;
      }
      try {
        signal.throwIfAborted();
        await listen(voice, settings.voicePort);
        signal.throwIfAborted();
        let closed = false;
        const reservation: Reservation = { bridge, voice, ready: false, taken: new Set(), close: async () => {
          if (closed) return;
          closed = true;
          if (managedReservation === reservation) managedReservation = undefined;
          await Promise.all([closeServer(bridge), closeServer(voice)]);
        } };
        current = reservation;
        return reservation;
      } catch (error) {
        await Promise.all([closeServer(bridge), closeServer(voice)]);
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error('Another Fabric backend did not become ready; nothing was stopped');
    await delay(100, undefined, { signal });
  }
}

export interface ManagedBackendOptions {
  signal: AbortSignal;
  loadSettings(): Promise<Endpoint>;
  start(signal: AbortSignal): Promise<{ shutdown(): Promise<void>; closed: Promise<void> }>;
  announce?(message: string): void;
}

/** Startup must finish/abort before cleanup, so late asynchronous startup cannot reopen closed resources. */
export async function runManagedBackend(options: ManagedBackendOptions): Promise<'reused' | 'stopped'> {
  let reservation: Reservation | null = null;
  let application: Awaited<ReturnType<ManagedBackendOptions['start']>> | undefined;
  try {
    options.signal.throwIfAborted();
    const settings = await options.loadSettings();
    options.signal.throwIfAborted();
    reservation = await reserveManagedPorts(settings, options.signal);
    options.signal.throwIfAborted();
    if (!reservation) { options.announce?.('Existing paired Fabric backend reused; it remains independently managed.'); return 'reused'; }
    managedReservation = reservation;
    application = await options.start(options.signal);
    options.signal.throwIfAborted();
    reservation.ready = true;
    options.announce?.('Minecraft-managed Fabric backend ready. It will stop when Minecraft exits.');
    await Promise.race([application.closed, new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', () => resolve(), { once: true });
    })]);
    return 'stopped';
  } catch (error) {
    if (!options.signal.aborted) throw error;
    return 'stopped';
  } finally {
    if (reservation) reservation.ready = false;
    try { await application?.shutdown(); } finally { await reservation?.close(); }
  }
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { BrowserVoiceReply } from './browserTypes.js';
import { errorMessage } from '../utils/errors.js';
import { browserHtml, browserScript, captureWorklet } from './browserPanel.js';
import { takeManagedServer } from '../core/managedLifetime.js';

export interface BrowserVoiceBackend {
  status(): Record<string, unknown>;
  converse(audio: Buffer, signal: AbortSignal): Promise<BrowserVoiceReply>;
  interrupt?(audio: Buffer, signal: AbortSignal): Promise<BrowserVoiceReply>;
  stop?(): Promise<void>;
}

const MAX_AUDIO = 48_000 * 2 * 20;

/** A loopback-only control surface. No filesystem, API keys, or arbitrary actions are exposed. */
export class BrowserVoiceServer {
  private server: Server | null = null;
  private token = randomBytes(32).toString('hex');
  private origin = '';
  private active: AbortController | null = null;
  private interruption: AbortController | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly backend: BrowserVoiceBackend, private readonly options: { unlimitedTurns?: boolean | (() => boolean) } = {}) {}

  get url(): string | null { return this.server ? this.origin : null; }

  async listen(port = 3001): Promise<string> {
    if (this.server) return this.origin;
    this.token = randomBytes(32).toString('hex');
    const server = takeManagedServer('voice', port) ?? createServer();
    server.on('request', (req, res) => { void this.handle(req, res).catch((error) => {
      if (!res.writableEnded && !res.destroyed) this.json(res, 500, { success: false, reason: errorMessage(error) });
    }); });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Browser voice address is unavailable');
    this.origin = `http://127.0.0.1:${address.port}`;
    this.server = server;
    return this.origin;
  }

  async close(): Promise<void> {
    this.active?.abort();
    this.interruption?.abort();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; media-src 'self' blob:; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const host = new URL(this.origin).host;
    if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== this.origin)) {
      this.json(res, 403, { success: false, reason: 'Use the exact local voice panel URL printed by the bot' }); return;
    }
    const route = req.url;
    if (route?.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') {
      this.json(res, 403, { success: false, reason: 'Cross-site requests are not allowed' }); return;
    }
    if (req.method === 'GET' && (route === '/' || route === '/app.js' || route === '/capture.js')) {
      res.setHeader('Content-Type', route === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
      res.end(route === '/' ? browserHtml : route === '/app.js' ? browserScript : captureWorklet); return;
    }
    if (req.method === 'GET' && route === '/api/session') {
      this.json(res, 200, { token: this.token, ...this.status() }); return;
    }
    const supplied = req.headers['x-voice-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) {
      this.json(res, 403, { success: false, reason: 'Reload the local voice panel to reconnect' }); return;
    }
    if (req.method === 'GET' && route === '/api/status') {
      this.json(res, 200, this.status()); return;
    }
    if (req.method !== 'POST' || !['/api/voice', '/api/interrupt', '/api/stop'].includes(route ?? '')) { this.json(res, 404, { success: false, reason: 'Not found' }); return; }
    if (req.headers.origin !== this.origin) { this.json(res, 403, { success: false, reason: 'A same-origin browser request is required' }); return; }
    if (route === '/api/stop') {
      req.resume();
      this.active?.abort();
      this.interruption?.abort();
      if (!this.stopping) {
        const stopping = Promise.resolve().then(() => this.backend.stop?.());
        this.stopping = stopping;
        void stopping.finally(() => { if (this.stopping === stopping) this.stopping = null; }).catch(() => {});
      }
      await this.stopping;
      this.json(res, 200, { success: true, stopped: true }); return;
    }
    const interrupt = route === '/api/interrupt';
    if (interrupt && !this.supportsInterrupt()) { this.json(res, 404, { success: false, reason: 'Spoken interruption is unavailable' }); return; }
    if (req.headers['content-type'] !== 'application/octet-stream') { this.json(res, 415, { success: false, reason: 'Expected mono 48 kHz PCM audio' }); return; }
    // A stop transcription belongs to the current task. Do not let a newer task overtake it.
    if (this.stopping || this.interruption || (!interrupt && this.active)) { this.json(res, 409, { success: false, reason: interrupt ? 'A spoken interruption is already processing.' : 'Another voice turn or interruption is processing. Wait for its reply.' }); return; }
    if (Number(req.headers['content-length'] ?? 0) > MAX_AUDIO) { this.json(res, 413, { success: false, reason: 'Recording exceeds 20 seconds' }); return; }
    const controller = new AbortController();
    if (interrupt) this.interruption = controller; else this.active = controller;
    const onAbort = () => {
      // Respond even if an upstream implementation ignores cancellation. Late results cannot revive this turn.
      if (!res.writableEnded && !res.destroyed) this.json(res, 200, { success: true, stopped: true });
      if (this.active === controller) this.active = null;
      if (this.interruption === controller) this.interruption = null;
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', cancel);
    res.once('close', cancel);
    const timer = !interrupt && !this.unlimitedTurns() ? setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) this.json(res, 504, { success: false, reason: 'Voice turn timed out; actions already started may still be running' });
      controller.abort();
    }, 180_000) : undefined;
    timer?.unref();
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        controller.signal.throwIfAborted();
        size += chunk.length;
        if (size > MAX_AUDIO) { this.json(res, 413, { success: false, reason: 'Recording exceeds 20 seconds' }); return; }
        chunks.push(chunk);
      }
      if (size < 9600 || size % 2 !== 0) { this.json(res, 400, { success: false, reason: 'Recording is too short or malformed' }); return; }
      controller.signal.throwIfAborted();
      const reply = await (interrupt ? this.backend.interrupt!(Buffer.concat(chunks), controller.signal) : this.backend.converse(Buffer.concat(chunks), controller.signal));
      if (interrupt && reply.stopped && !controller.signal.aborted) this.active?.abort();
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) this.json(res, 200, reply);
    } finally {
      clearTimeout(timer);
      req.removeListener('aborted', cancel);
      res.removeListener('close', cancel);
      controller.signal.removeEventListener('abort', onAbort);
      if (this.active === controller) this.active = null;
      if (this.interruption === controller) this.interruption = null;
    }
  }

  private status(): Record<string, unknown> {
    return { ...this.backend.status(), busy: Boolean(this.active || this.stopping),
      supportsInterrupt: this.supportsInterrupt(), unlimitedTurns: this.unlimitedTurns() };
  }

  private supportsInterrupt(): boolean {
    return Boolean(this.backend.interrupt && this.backend.stop && this.backend.status().supportsInterrupt !== false);
  }

  private unlimitedTurns(): boolean {
    return typeof this.options.unlimitedTurns === 'function' ? this.options.unlimitedTurns() : Boolean(this.options.unlimitedTurns);
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }
}

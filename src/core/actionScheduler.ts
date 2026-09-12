import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import type { ActionResult, ActionState } from '../minecraft/types.js';
import type { Logger } from 'pino';

interface PendingAction {
  id: number;
  name: string;
  state: ActionState;
  priority: number;
  timeoutMs: number;
  operation: (signal: AbortSignal) => Promise<ActionResult>;
  resolve: (value: ActionResult) => void;
}

interface ActiveAction extends PendingAction {
  controller: AbortController;
  timer: NodeJS.Timeout | null;
}

export class ActionScheduler {
  private queue: PendingAction[] = [];
  private active: ActiveAction | null = null;
  private sequence = 0;

  constructor(
    private readonly minecraft: MinecraftAgent,
    private readonly logger: Logger
  ) {}

  get currentState(): ActionState {
    return this.active?.state ?? 'IDLE';
  }

  get busy(): boolean {
    return this.active !== null;
  }

  schedule(
    name: string,
    state: ActionState,
    priority: number,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<ActionResult>,
    requestSignal?: AbortSignal
  ): Promise<ActionResult> {
    return new Promise<ActionResult>((resolve) => {
      if (requestSignal?.aborted) {
        resolve({ success: false, action: name, reason: 'Request cancelled before action started' });
        return;
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        resolve({ success: false, action: name, reason: 'Invalid action timeout' });
        return;
      }
      const pending: PendingAction = {
        id: ++this.sequence,
        name,
        state,
        priority,
        timeoutMs,
        operation,
        resolve: (result) => { requestSignal?.removeEventListener('abort', cancel); resolve(result); }
      };
      const cancel = () => {
        if (this.active?.id === pending.id) {
          void this.interrupt('Request cancelled');
        } else {
          this.queue = this.queue.filter((item) => item.id !== pending.id);
          pending.resolve({ success: false, action: name, reason: 'Request cancelled before action started' });
        }
      };
      requestSignal?.addEventListener('abort', cancel, { once: true });
      if (this.active && priority > this.active.priority) {
        void this.interrupt(`Interrupted by higher-priority action '${name}'`);
      }
      this.queue.push(pending);
      this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
      void this.pump();
    });
  }

  async interrupt(reason: string): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort(new Error(reason));
    if (active.timer) clearTimeout(active.timer);
    await this.minecraft.cancelCurrentAction(reason).catch(() => undefined);
    this.logger.warn({ action: active.name, reason }, 'Action interrupted');
  }

  async stop(): Promise<void> {
    for (const pending of this.queue.splice(0)) {
      pending.resolve({ success: false, action: pending.name, reason: 'Scheduler stopped' });
    }
    await this.interrupt('Scheduler stopped');
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const pending = this.queue.shift();
    if (!pending) return;
    const controller = new AbortController();
    // Zero explicitly disables the action deadline; cancellation still owns input cleanup.
    const timer = pending.timeoutMs === 0 ? null : setTimeout(() => {
      controller.abort(new Error(`${pending.name} timed out after ${pending.timeoutMs}ms`));
      void this.minecraft.cancelCurrentAction('Action timeout').catch(() => undefined);
    }, pending.timeoutMs);
    this.active = { ...pending, controller, timer };
    this.logger.info({ action: pending.name, state: pending.state, priority: pending.priority }, 'Action started');
    const started = Date.now();
    try {
      const aborted = new Promise<ActionResult>((resolve) => {
        controller.signal.addEventListener(
          'abort',
          () => resolve({ success: false, action: pending.name, reason: String(controller.signal.reason ?? 'Cancelled') }),
          { once: true }
        );
      });
      const operation = pending.operation(controller.signal);
      const result = await Promise.race([operation, aborted]);
      pending.resolve({ ...result, durationMs: result.durationMs ?? Date.now() - started });
    } catch (error) {
      pending.resolve({
        success: false,
        action: pending.name,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (this.active?.id === pending.id) this.active = null;
      queueMicrotask(() => void this.pump());
    }
  }
}

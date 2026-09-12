import type { Logger } from 'pino';
import { sleep } from '../utils/sleep.js';

export async function retryWithBackoff(
  operation: () => Promise<void>,
  options: { attempts: number; baseDelayMs: number; label: string; logger: Logger; signal?: AbortSignal }
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts) break;
      const delayMs = Math.min(options.baseDelayMs * 2 ** (attempt - 1), 60_000) + Math.floor(Math.random() * 500);
      options.logger.warn({ attempt, delayMs, error }, `${options.label} failed; retrying`);
      await sleep(delayMs, options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${options.label} failed`);
}

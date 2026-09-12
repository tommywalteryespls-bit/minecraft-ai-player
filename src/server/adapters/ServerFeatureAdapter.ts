import type { ActionResult } from '../../minecraft/types.js';

export interface ServerFeatureAdapter {
  readonly actions: readonly string[];
  execute(action: string, arguments_: Record<string, unknown>): Promise<ActionResult>;
}

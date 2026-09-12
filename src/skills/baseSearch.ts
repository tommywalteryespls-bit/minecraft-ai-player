import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import type { ActionResult, Position, WorldState } from '../minecraft/types.js';
import type { MemoryManager } from '../memory/memoryManager.js';
import { detectBaseEvidence, type BaseEvidence, type SearchScan } from './baseSearchEvidence.js';
import { normalizeSearchPattern, searchPointAtStep } from './baseSearchPattern.js';

const coordinate = z.number().int().min(-29_999_984).max(29_999_984);
const cellSchema = z.object({ x: coordinate, y: z.number().int().min(-2048).max(2047), z: coordinate }).strict();
const directionSchema = z.enum(['north', 'east', 'south', 'west']);
export const BaseSearchRequestSchema = z.object({
  origin: cellSchema.nullish(), height: z.number().int().min(-2048).max(2047).nullish(), direction: directionSchema.nullish(),
  branch_length: z.number().int().min(1).max(256).nullish(), branch_spacing: z.number().int().min(2).max(32).nullish(),
  max_branches: z.number().int().min(1).max(10000).nullish()
}).strict();
export type BaseSearchRequest = z.infer<typeof BaseSearchRequestSchema>;
const patternSchema = z.object({ origin: cellSchema, direction: directionSchema,
  branchLength: z.number().int().min(1).max(256), branchSpacing: z.number().int().min(2).max(32) }).strict();
const savedSchema = z.object({
  kind: z.literal('base-search-v1'), dimension: z.string().min(1).max(128), pattern: patternSchema,
  maxBranches: z.number().int().min(1).max(10000).nullable(), completedSteps: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pendingStep: cellSchema.nullable(), state: z.enum(['running', 'paused', 'blocked', 'awaiting_confirmation', 'exhausted']),
  reason: z.string().max(4096), updatedAt: z.string(), evidence: z.record(z.string(), z.json()).nullable()
}).strict();
type SavedSearch = z.infer<typeof savedSchema>;
const scanSchema = z.object({ center: cellSchema, radius: z.number().int().min(1).max(6), complete: z.boolean(),
  blocks: z.array(z.object({ name: z.string().regex(/^(?:minecraft:)?[a-z0-9_]+$/).max(128), position: cellSchema })).max(2197)
});
const cell = (position: Position): Position => ({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) });
const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y && a.z === b.z;
const key = (position: Position) => `${position.x},${position.y},${position.z}`;
const atCell = (world: WorldState, position: Position) => same(cell(world.position), position) && Math.abs(world.position.y - position.y) < 0.4;
const directions = ['south', 'west', 'north', 'east'] as const;
// A cancelled primitive can settle after a resume starts. Its stale continuation
// must never overwrite the new run's coverage, including across runner instances.
const leases = new WeakMap<MemoryManager, Map<string, symbol>>();

/** A persistent prefix of a deterministic search path is the coverage map: constant-size,
 * resumable, no claims that unloaded surrounding terrain or skipped cells were searched. */
export class BaseSearchRunner {
  constructor(private readonly minecraft: MinecraftAgent, private readonly memory: MemoryManager) {}

  async run(request: BaseSearchRequest, signal: AbortSignal): Promise<ActionResult> {
    const parsed = BaseSearchRequestSchema.safeParse(request);
    if (!parsed.success) return this.failure('Invalid base search origin, direction, height or branch dimensions');
    if (!this.memory.enabled) return this.failure('Base search requires MEMORY_ENABLED=true to save coverage and resume reliably');
    if (!this.supported()) return this.failure('Install the base-search Fabric mod update first');
    try {
      signal.throwIfAborted();
      const world = await this.minecraft.getWorldState(); signal.throwIfAborted();
      const value = parsed.data, origin = value.origin ?? cell(world.position);
      if (value.origin && value.height != null && value.origin.y !== value.height) return this.failure('Origin Y and search height must agree');
      const pattern = normalizeSearchPattern({ origin: { ...origin, y: value.height ?? origin.y },
        direction: value.direction ?? directions[((Math.round((world.yaw ?? 0) / 90) % 4) + 4) % 4]!,
        branchLength: value.branch_length ?? 32, branchSpacing: value.branch_spacing ?? 4 });
      // Do not silently create an unscanned route or descend through somebody's structure.
      if (!atCell(world, pattern.origin)) return this.failure('Stand at the requested origin and mining height first; base search does not excavate a separate route to its origin');
      const saved: SavedSearch = { kind: 'base-search-v1', dimension: world.dimension, pattern,
        maxBranches: value.max_branches ?? null, completedSteps: 0, pendingStep: null, state: 'running', reason: '', evidence: null, updatedAt: new Date().toISOString() };
      const goal = this.memory.setGoal({ scope: 'server', serverId: world.serverId, priority: 80,
        description: `Search for a suspected underground base at Y ${pattern.origin.y}, ${pattern.direction}`, notes: JSON.stringify(saved) });
      return this.execute(goal.id, world.serverId, saved, signal);
    } catch (error) { return this.failure(this.reason(error)); }
  }

  async resume(id: string, signal: AbortSignal): Promise<ActionResult> {
    if (!this.memory.enabled || !this.supported()) return this.failure('Resuming requires memory and the base-search Fabric update', 'resume_base_search');
    const goal = this.memory.getGoals(this.minecraft.serverId).find((g) => g.id === id && g.scope === 'server' && g.serverId === this.minecraft.serverId);
    if (!goal) return this.failure('No active base-search goal with that ID in this world', 'resume_base_search');
    try {
      const saved = savedSchema.parse(JSON.parse(goal.notes));
      normalizeSearchPattern(saved.pattern);
      const total = this.totalSteps(saved);
      if (saved.completedSteps > total || (saved.pendingStep && (saved.completedSteps >= total || !same(saved.pendingStep, searchPointAtStep(saved.pattern, saved.completedSteps + 1))))) throw new Error('Invalid saved coverage cursor');
      signal.throwIfAborted();
      const world = await this.minecraft.getWorldState(); signal.throwIfAborted();
      if (world.dimension !== saved.dimension) return this.failure('Resume in the original dimension; no movement was started', 'resume_base_search');
      return this.execute(id, goal.serverId!, saved, signal);
    } catch (error) { return this.failure(`Cannot resume this search: ${this.reason(error)}`, 'resume_base_search'); }
  }

  status(id?: string | null): ActionResult {
    const searches = this.memory.getGoals(this.minecraft.serverId, true).filter((g) => g.scope === 'server' && g.serverId === this.minecraft.serverId && (!id || g.id === id)).flatMap((g) => {
      try { const parsed = savedSchema.safeParse(JSON.parse(g.notes)); return parsed.success ? [{ goalId: g.id, ...this.summary(parsed.data) }] : []; }
      catch { return []; }
    });
    return { success: !id || searches.length > 0, action: 'inspect_base_search', data: { searches },
      ...(!searches.length && id ? { reason: 'No base search with that ID in the current world' } : {}) };
  }

  private async execute(id: string, worldId: string, saved: SavedSearch, signal: AbortSignal): Promise<ActionResult> {
    const owners = leases.get(this.memory) ?? new Map<string, symbol>(); leases.set(this.memory, owners);
    const lease = Symbol(id); owners.set(id, lease);
    const persist = () => { if (owners.get(id) !== lease) return; saved.updatedAt = new Date().toISOString(); this.memory.updateGoal(id, saved.state === 'exhausted' ? 'completed' : 'active', JSON.stringify(saved)); };
    const check = () => {
      signal.throwIfAborted();
      if (owners.get(id) !== lease) throw new Error('Search execution was superseded by a newer run');
      if (!this.minecraft.connected || this.minecraft.serverId !== worldId || this.minecraft.controlStatus?.().enabled === false) throw new Error('World connection or player control changed');
    };
    const read = async () => { check(); const world = await this.minecraft.getWorldState(); check(); if (world.dimension !== saved.dimension) throw new Error('Dimension changed; resume in the original dimension'); return world; };
    const paused = () => { saved.state = 'paused'; saved.reason = 'Search cancelled; coverage saved. Resume only when the user asks.'; try { persist(); } catch { /* Shutdown may have already closed the database. */ } };
    const candidate = (evidence: Record<string, unknown>, reason: string): ActionResult => {
      saved.state = 'awaiting_confirmation'; saved.reason = reason; saved.evidence = JSON.parse(JSON.stringify(evidence)) as SavedSearch['evidence']; persist();
      return { success: true, action: 'search_for_base', data: { goalId: id, outcome: 'suspected_structure', baseConfirmed: false,
        requiresUserConfirmation: true, ...this.summary(saved) } };
    };
    signal.addEventListener('abort', paused, { once: true });
    try {
      saved.state = 'running'; saved.reason = ''; check(); persist();
      while (true) {
        const world = await read();
        const expected = searchPointAtStep(saved.pattern, saved.completedSteps);
        const recoveringArrival = Boolean(saved.pendingStep && atCell(world, saved.pendingStep));
        if (!atCell(world, expected) && !recoveringArrival) throw new Error(`Return to the last search cell ${key(expected)}${saved.pendingStep ? ` or interrupted destination ${key(saved.pendingStep)}` : ''} before resuming; no unscanned travel was attempted`);
        const scanned = await this.minecraft.scanSearchArea!(4); check();
        if (!scanned.success) throw new Error(scanned.reason ?? 'Search scan failed');
        const afterScan = await read();
        if (!atCell(afterScan, recoveringArrival ? saved.pendingStep! : expected)) throw new Error('Player moved during scanning; no search step was started');
        const scan = this.validScan(scanned.data, afterScan);
        const report: BaseEvidence = detectBaseEvidence(scan);
        saved.evidence = JSON.parse(JSON.stringify(report)) as SavedSearch['evidence'];
        if (report.suspected) return candidate({ ...report }, report.summary);
        if (!report.safeToContinue) throw new Error(report.summary || 'Scan is incomplete; no excavation was attempted');
        if (recoveringArrival) {
          // Cancellation can arrive after movement but before its acknowledgement. Reconcile
          // only the persisted adjacent destination, never infer arbitrary travel as coverage.
          this.requireClearCell(scan, saved.pendingStep!);
          saved.completedSteps++; saved.pendingStep = null; persist();
          continue;
        }
        if (saved.completedSteps >= this.totalSteps(saved)) {
          saved.state = 'exhausted'; saved.reason = 'Requested branches searched; no convincing base evidence found'; persist();
          return { success: true, action: 'search_for_base', data: { goalId: id, outcome: 'area_exhausted', baseConfirmed: false, ...this.summary(saved) } };
        }
        const target = searchPointAtStep(saved.pattern, saved.completedSteps + 1);
        cellSchema.parse(target);
        saved.pendingStep = target; persist(); check();
        const result = await this.minecraft.baseSearchStep!(target); check();
        if (!result.success) {
          if (result.data?.suspectedStructure === true) return candidate({ source: 'pre-break structure guard', blockedBlock: result.data.blockedBlock ?? null, confidence: 'low' },
            result.reason ?? 'Possible constructed structure ahead; stopped before further excavation');
          throw new Error(result.reason ?? 'Search step did not complete');
        }
        const after = await read();
        if (!atCell(after, target)) throw new Error('Movement acknowledgement did not match the next search cell; coverage was not advanced');
        saved.completedSteps++; saved.pendingStep = null; saved.reason = ''; persist();
        // No paid model calls in this loop. Yield to cancellation and state packets.
        await delay(25, undefined, { signal });
      }
    } catch (error) {
      saved.state = signal.aborted ? 'paused' : 'blocked'; saved.reason = this.reason(error); persist();
      return { success: false, action: 'search_for_base', reason: saved.reason, data: { goalId: id, resumable: true, ...this.summary(saved) } };
    } finally { signal.removeEventListener('abort', paused); if (owners.get(id) === lease) owners.delete(id); }
  }

  private validScan(data: unknown, world: WorldState): SearchScan {
    const scan = scanSchema.parse(data);
    if (!scan.complete || !same(scan.center, cell(world.position))) throw new Error('Incomplete or stale loaded-block scan; search paused without excavation');
    const size = 2 * scan.radius + 1;
    const seen = new Set<string>();
    for (const block of scan.blocks) {
      if (Math.max(Math.abs(block.position.x - scan.center.x), Math.abs(block.position.y - scan.center.y), Math.abs(block.position.z - scan.center.z)) > scan.radius) throw new Error('Search scan contains out-of-range cells');
      seen.add(key(block.position));
    }
    if (seen.size !== size ** 3 || seen.size !== scan.blocks.length) throw new Error('Search scan omitted or repeated cells; no excavation was attempted');
    return scan;
  }
  private requireClearCell(scan: SearchScan, position: Position): void {
    for (const target of [position, { ...position, y: position.y + 1 }]) {
      const block = scan.blocks.find((b) => same(b.position, target));
      if (!block || !['air', 'cave_air', 'void_air'].includes(block.name.replace(/^minecraft:/, ''))) throw new Error('Interrupted destination is not a clear two-block corridor; coverage unchanged');
    }
  }
  private summary(saved: SavedSearch): Record<string, unknown> {
    const point = (step: number) => { try { return searchPointAtStep(saved.pattern, step); } catch { return null; } };
    const lastPosition = point(saved.completedSteps);
    const total = this.totalSteps(saved);
    return { state: saved.state, reason: saved.reason, dimension: saved.dimension, pattern: saved.pattern, maxBranches: saved.maxBranches,
      coverage: { completedSteps: saved.completedSteps, lastPosition, nextPosition: saved.completedSteps < total ? point(saved.completedSteps + 1) : null,
        pendingStep: saved.pendingStep, representation: 'confirmed contiguous search-path prefix, including connecting tunnels' }, evidence: saved.evidence };
  }
  private totalSteps(saved: SavedSearch): number { return saved.maxBranches === null ? Infinity : saved.maxBranches * saved.pattern.branchLength + (saved.maxBranches - 1) * saved.pattern.branchSpacing; }
  private supported(): boolean { return Boolean(this.minecraft.scanSearchArea && this.minecraft.baseSearchStep && ['scan_search_area', 'base_search_step'].every((name) => this.minecraft.supportedActions?.includes(name))); }
  private reason(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }
  private failure(reason: string, action = 'search_for_base'): ActionResult { return { success: false, action, reason }; }
}

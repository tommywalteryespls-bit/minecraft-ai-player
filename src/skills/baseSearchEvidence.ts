import type { Position } from '../minecraft/types.js';

export interface SearchBlock { name: string; position: Position }
export interface SearchScan { center: Position; radius: number; complete: boolean; blocks: SearchBlock[] }
export type EvidenceCategory = 'storage' | 'workstation' | 'domestic' | 'light' | 'construction';
export interface BaseEvidenceItem extends SearchBlock { category: EvidenceCategory }
export interface BaseEvidence {
  suspected: boolean;
  confidence: 'none' | 'low' | 'medium' | 'high';
  /** False on incomplete/invalid scans even if there is no positive evidence. */
  safeToContinue: boolean;
  summary: string;
  evidence: BaseEvidenceItem[];
  complete: boolean;
}

const storage = new Set(['chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box']);
const workstation = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'brewing_stand', 'smithing_table', 'stonecutter', 'cartography_table', 'fletching_table', 'loom', 'grindstone', 'lectern']);
const light = new Set(['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'lantern', 'soul_lantern', 'redstone_torch', 'redstone_wall_torch', 'redstone_lamp']);

function category(name: string): EvidenceCategory | undefined {
  if (storage.has(name) || name.endsWith('_shulker_box')) return 'storage';
  if (workstation.has(name)) return 'workstation';
  if (name.endsWith('_bed') || name.endsWith('_door')) return 'domestic';
  if (light.has(name) || name === 'candle' || name.endsWith('_candle')) return 'light';
  if (name.endsWith('_planks') || name.endsWith('_wool') || name.endsWith('_concrete') || name.endsWith('_stained_glass') || name.endsWith('_stained_glass_pane') || name === 'glass' || name === 'glass_pane' || name === 'bricks' || name === 'stone_bricks' || name === 'polished_andesite' || name === 'polished_diorite' || name === 'polished_granite') return 'construction';
  return undefined;
}

function finitePosition(position: Position | undefined): position is Position {
  return !!position && [position.x, position.y, position.z].every(Number.isFinite)
    && Math.abs(position.x) <= 30_000_000 && Math.abs(position.z) <= 30_000_000 && position.y >= -2048 && position.y <= 2048;
}
function distanceSquared(a: Position, b: Position): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}
function strength(items: BaseEvidenceItem[]): number {
  const categories = new Set(items.map((item) => item.category));
  const functional = Number(categories.has('storage')) + Number(categories.has('workstation')) + Number(categories.has('domestic'));
  const constructionKinds = new Set(items.filter((item) => item.category === 'construction').map((item) => item.name)).size;
  if (functional === 3 && categories.size >= 4) return 3;
  if (functional >= 2 || (functional >= 1 && categories.has('light') && constructionKinds >= 2)) return 2;
  return items.length > 0 ? 1 : 0;
}

/**
 * Nearby combinations identify a suspected structure, never prove a player-built base.
 * Air/tunnel shape is deliberately not evidence: this routine creates its own corridors.
 * Exclusions therefore do not hide solid blocks subsequently placed in a visited corridor.
 */
export function detectBaseEvidence(scan: SearchScan, _excludedPositions: readonly Position[] = []): BaseEvidence {
  if (!scan || !finitePosition(scan.center) || !Number.isInteger(scan.radius) || scan.radius < 1 || scan.radius > 64 || !Array.isArray(scan.blocks)) {
    return { suspected: false, confidence: 'none', safeToContinue: false, complete: false, summary: 'The surroundings scan is invalid; stop and obtain a complete scan before mining.', evidence: [] };
  }
  let complete = scan.complete === true;
  const unique = new Map<string, BaseEvidenceItem>();
  const seen = new Map<string, string>();
  for (const block of scan.blocks) {
    if (!block || typeof block.name !== 'string' || !finitePosition(block.position) || ![block.position.x, block.position.y, block.position.z].every(Number.isInteger)) {
      complete = false;
      continue;
    }
    const rawName = block.name.startsWith('minecraft:') ? block.name.slice(10) : block.name;
    if (!/^[a-z0-9_]+$/.test(rawName)) { complete = false; continue; }
    if (Math.max(Math.abs(block.position.x - scan.center.x), Math.abs(block.position.y - scan.center.y), Math.abs(block.position.z - scan.center.z)) > scan.radius) {
      complete = false;
      continue;
    }
    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    if (seen.has(key)) {
      if (seen.get(key) !== rawName) complete = false;
      continue;
    }
    seen.set(key, rawName);
    const kind = category(rawName);
    if (kind) unique.set(key, { name: rawName, position: { ...block.position }, category: kind });
  }
  const candidates = [...unique.values()];
  const bucketKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const buckets = new Map<string, BaseEvidenceItem[]>();
  for (const item of candidates) {
    const key = bucketKey(Math.floor(item.position.x / 6), Math.floor(item.position.y / 6), Math.floor(item.position.z / 6));
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  // A local room-sized cluster is required; unrelated signs across the scan do not accumulate.
  let evidence: BaseEvidenceItem[] = [];
  let score = 0;
  for (const anchor of candidates) {
    const cluster: BaseEvidenceItem[] = [];
    const bx = Math.floor(anchor.position.x / 6), by = Math.floor(anchor.position.y / 6), bz = Math.floor(anchor.position.z / 6);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const item of buckets.get(bucketKey(bx + dx, by + dy, bz + dz)) ?? []) {
        if (distanceSquared(anchor.position, item.position) <= 36) cluster.push(item);
      }
    }
    const value = strength(cluster);
    if (value > score || (value === score && cluster.length > evidence.length)) { evidence = cluster; score = value; }
    if (score === 3) break;
  }
  const confidence = (['none', 'low', 'medium', 'high'] as const)[score]!;
  const suspected = score >= 2;
  const names = [...new Set(evidence.map((item) => item.name))].join(', ');
  const observation = suspected
    ? `Possible underground structure: a nearby combination of ${names}. This may be a naturally generated structure, not a player base; stop excavation and report the evidence.`
    : score === 1
      ? `Isolated structure indicators (${names}) are not enough to identify a base. Natural structures can contain these blocks.`
      : 'No base indicators were observed in the scanned surroundings; this does not rule out a base outside the scan or hidden by the server.';
  const summary = complete ? observation : `The surroundings scan is incomplete; do not continue mining. ${observation}`;
  return { suspected, confidence, safeToContinue: complete && !suspected, summary, evidence, complete };
}

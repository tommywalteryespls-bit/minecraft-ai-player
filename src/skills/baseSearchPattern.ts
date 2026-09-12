import type { Position } from '../minecraft/types.js';

export type SearchDirection = 'north' | 'east' | 'south' | 'west';
export interface SearchPatternSpec {
  origin: Position;
  direction: SearchDirection;
  branchLength: number;
  branchSpacing: number;
}
export interface SearchProgress {
  branchIndex: number;
  phase: 'branch' | 'connector';
  offset: number;
  position: Position;
}

export const searchDirections: Readonly<Record<SearchDirection, Readonly<Position>>> = {
  north: { x: 0, y: 0, z: -1 }, east: { x: 1, y: 0, z: 0 },
  south: { x: 0, y: 0, z: 1 }, west: { x: -1, y: 0, z: 0 },
};

export function positionKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`;
}

function blockPosition(position: Position): Position {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error('Search coordinates must be finite numbers');
  }
  const result = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  // The broad Y range also permits custom dimensions. Native world bounds are checked before mining.
  if (Math.abs(result.x) > 29_999_984 || Math.abs(result.z) > 29_999_984 || result.y < -2048 || result.y > 2047) {
    throw new Error('Search coordinates are outside supported world bounds');
  }
  return result;
}

export function normalizeSearchPattern(spec: SearchPatternSpec): SearchPatternSpec {
  if (!spec || !Object.hasOwn(searchDirections, spec.direction)) throw new Error('Search direction must be north, east, south, or west');
  if (!Number.isInteger(spec.branchLength) || spec.branchLength < 1 || spec.branchLength > 256) {
    throw new Error('Search branch length must be an integer between 1 and 256');
  }
  if (!Number.isInteger(spec.branchSpacing) || spec.branchSpacing < 2 || spec.branchSpacing > 32) {
    throw new Error('Search branch spacing must be an integer between 2 and 32');
  }
  return { origin: blockPosition(spec.origin), direction: spec.direction, branchLength: spec.branchLength, branchSpacing: spec.branchSpacing };
}

/** Step zero is the origin. Every later step is exactly one adjacent block at the same height. */
export function searchPointAtStep(spec: SearchPatternSpec, completedSteps: number): Position {
  return searchProgressAtStep(spec, completedSteps).position;
}

/** A completed prefix is enough to reconstruct coverage without retaining an ever-growing coordinate list. */
export function searchProgressAtStep(spec: SearchPatternSpec, completedSteps: number): SearchProgress {
  const normalized = normalizeSearchPattern(spec);
  if (!Number.isSafeInteger(completedSteps) || completedSteps < 0) throw new Error('Search progress must be a non-negative safe integer');
  const { origin, direction, branchLength, branchSpacing } = normalized;
  const cycleLength = branchLength + branchSpacing;
  const branchIndex = Math.floor(completedSteps / cycleLength);
  const within = completedSteps % cycleLength;
  const phase = within <= branchLength ? 'branch' : 'connector';
  const forward = searchDirections[direction];
  const right = { x: -forward.z, z: forward.x };
  const along = branchIndex % 2 === 0 ? Math.min(within, branchLength) : branchLength - Math.min(within, branchLength);
  const across = branchIndex * branchSpacing + Math.max(0, within - branchLength);
  const position = blockPosition({ x: origin.x + forward.x * along + right.x * across, y: origin.y, z: origin.z + forward.z * along + right.z * across });
  return { branchIndex, phase, offset: phase === 'branch' ? within : within - branchLength, position };
}

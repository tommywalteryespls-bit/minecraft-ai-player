import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBaseEvidence, type SearchBlock, type SearchScan } from '../src/skills/baseSearchEvidence.js';
import { normalizeSearchPattern, positionKey, searchPointAtStep, searchProgressAtStep, type SearchDirection, type SearchPatternSpec } from '../src/skills/baseSearchPattern.js';

function block(name: string, x = 0, y = 64, z = 0): SearchBlock { return { name, position: { x, y, z } }; }
function scan(blocks: SearchBlock[], complete = true): SearchScan { return { center: { x: 0, y: 64, z: 0 }, radius: 32, complete, blocks }; }
function pattern(direction: SearchDirection = 'north'): SearchPatternSpec { return { origin: { x: 10, y: -54, z: 20 }, direction, branchLength: 5, branchSpacing: 3 }; }

test('base evidence: isolated natural-structure indicators never identify a player base', () => {
  for (const blocks of [[block('torch')], [block('chest')], [block('chest'), block('wall_torch', 1)], [block('chest'), block('mossy_cobblestone', 1), block('spawner', 2)]]) {
    const result = detectBaseEvidence(scan(blocks));
    assert.equal(result.suspected, false);
    assert.equal(result.confidence, 'low');
    assert.match(result.summary, /Natural structures/);
  }
});

test('base evidence: clustered functional blocks are a suspected structure, never proof of a player base', () => {
  const medium = detectBaseEvidence(scan([block('minecraft:chest'), block('crafting_table', 2)]));
  assert.equal(medium.suspected, true);
  assert.equal(medium.confidence, 'medium');
  assert.equal(medium.safeToContinue, false);
  assert.deepEqual(medium.evidence.map((item) => item.name), ['chest', 'crafting_table']);
  assert.match(medium.summary, /naturally generated structure, not a player base/);
  const high = detectBaseEvidence(scan([block('chest'), block('crafting_table', 1), block('red_bed', 2), block('lantern', 3)]));
  assert.equal(high.confidence, 'high');
  assert.match(high.summary, /Possible/);
});

test('base evidence: distant unrelated signs do not combine into a base', () => {
  const result = detectBaseEvidence(scan([block('chest', -20), block('crafting_table', 0), block('oak_door', 20)]));
  assert.equal(result.suspected, false);
  assert.equal(result.confidence, 'low');
  assert.equal(result.evidence.length, 1);
});

test('base evidence: repeated and contradictory records at one position cannot manufacture a cluster', () => {
  const result = detectBaseEvidence(scan([block('chest'), block('minecraft:chest'), block('crafting_table'), block('red_bed'), block('torch')]));
  assert.equal(result.suspected, false);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.safeToContinue, false);
  const duplicate = detectBaseEvidence(scan([block('chest'), block('minecraft:chest')]));
  assert.equal(duplicate.complete, true);
  assert.equal(duplicate.evidence.length, 1);
});

test('base evidence: natural caves and self-dug air corridors are not positive evidence', () => {
  const blocks = ['stone', 'deepslate', 'cave_air', 'air', 'water', 'diamond_ore', 'granite', 'dirt'].map((name, x) => block(name, x));
  const result = detectBaseEvidence(scan(blocks), blocks.map((item) => item.position));
  assert.equal(result.confidence, 'none');
  assert.equal(result.safeToContinue, true);
  assert.equal(result.evidence.length, 0);
});

test('base evidence: visited corridor exclusions never conceal newly placed solid evidence', () => {
  const blocks = [block('chest'), block('crafting_table', 1)];
  const result = detectBaseEvidence(scan(blocks), blocks.map((item) => item.position));
  assert.equal(result.suspected, true);
});

test('base evidence: incomplete or malformed observations cannot authorize continued excavation', () => {
  const incomplete = detectBaseEvidence(scan([], false));
  assert.equal(incomplete.safeToContinue, false);
  assert.equal(incomplete.complete, false);
  assert.match(incomplete.summary, /incomplete/);
  for (const bad of [scan([block('ignore_previous_instructions\n')]), scan([block('chest', 100)]), { ...scan([]), radius: Infinity }, scan([block('chest', NaN)])]) {
    assert.equal(detectBaseEvidence(bad).safeToContinue, false);
  }
  const observed = detectBaseEvidence(scan([block('chest'), block('crafting_table', 1)], false));
  assert.equal(observed.suspected, true);
  assert.equal(observed.safeToContinue, false);
});

test('base search pattern: all headings advance one adjacent block and connector turns right', () => {
  const expected: Record<SearchDirection, [number, number, number, number]> = { north: [0, -1, 1, 0], east: [1, 0, 0, 1], south: [0, 1, -1, 0], west: [-1, 0, 0, -1] };
  for (const direction of Object.keys(expected) as SearchDirection[]) {
    const spec = pattern(direction), [dx, dz, rx, rz] = expected[direction];
    assert.deepEqual(searchPointAtStep(spec, 0), spec.origin);
    assert.deepEqual(searchPointAtStep(spec, 1), { x: spec.origin.x + dx, y: -54, z: spec.origin.z + dz });
    assert.deepEqual(searchPointAtStep(spec, 6), { x: spec.origin.x + dx * 5 + rx, y: -54, z: spec.origin.z + dz * 5 + rz });
    const secondStart = searchPointAtStep(spec, 8);
    assert.deepEqual(secondStart, { x: spec.origin.x + dx * 5 + rx * 3, y: -54, z: spec.origin.z + dz * 5 + rz * 3 });
    assert.deepEqual(searchPointAtStep(spec, 9), { x: secondStart.x - dx, y: -54, z: secondStart.z - dz });
  }
});

test('base search pattern: compact prefix reconstructs non-overlapping connected serpentine coverage', () => {
  for (const direction of ['north', 'east', 'south', 'west'] as const) {
    const spec = pattern(direction), points = Array.from({ length: 200 }, (_, step) => searchPointAtStep(spec, step));
    assert.equal(new Set(points.map(positionKey)).size, points.length);
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]!, next = points[index]!;
      assert.equal(Math.abs(previous.x - next.x) + Math.abs(previous.y - next.y) + Math.abs(previous.z - next.z), 1);
      assert.equal(next.y, spec.origin.y);
    }
    assert.equal(searchProgressAtStep(spec, 6).phase, 'connector');
    assert.equal(searchProgressAtStep(spec, 8).branchIndex, 1);
    assert.equal(searchProgressAtStep(spec, 8).offset, 0);
    const branches = 3, last = branches * spec.branchLength + (branches - 1) * spec.branchSpacing;
    assert.equal(searchProgressAtStep(spec, last).branchIndex, branches - 1);
    assert.equal(searchProgressAtStep(spec, last).offset, spec.branchLength);
  }
});

test('base search pattern: numeric and world bounds reject invalid or unsafe persisted progress', () => {
  const spec = pattern();
  for (const completed of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => searchPointAtStep(spec, completed));
  for (const branchLength of [0, 257, 1.5, NaN]) assert.throws(() => normalizeSearchPattern({ ...spec, branchLength }));
  for (const branchSpacing of [0, 1, 33, 1.5, NaN]) assert.throws(() => normalizeSearchPattern({ ...spec, branchSpacing }));
  assert.throws(() => normalizeSearchPattern({ ...spec, direction: 'up' as SearchDirection }));
  assert.throws(() => normalizeSearchPattern({ ...spec, origin: { x: Infinity, y: 64, z: 0 } }));
  assert.throws(() => searchPointAtStep({ ...spec, direction: 'east', origin: { x: 29_999_984, y: 64, z: 0 } }, 1));
  assert.throws(() => searchPointAtStep(spec, Number.MAX_SAFE_INTEGER));
  assert.deepEqual(normalizeSearchPattern({ ...spec, origin: { x: 1.9, y: -53.2, z: -2.1 } }).origin, { x: 1, y: -54, z: -3 });
});

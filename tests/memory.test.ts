import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryDatabase } from '../src/memory/database.js';
import { MemoryManager } from '../src/memory/memoryManager.js';

test('global memory persists while server memories stay namespaced', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-ai-memory-'));
  try {
    const file = path.join(directory, 'memory.sqlite');
    let manager = new MemoryManager(new MemoryDatabase(file), directory, true);
    manager.setIdentity('name', 'Aster');
    manager.addMemory({ scope: 'global', category: 'lesson', content: 'Always carry food while exploring', importance: 0.9 });
    manager.addMemory({ scope: 'server', serverId: 'alpha', category: 'location', content: 'Home is beside a birch forest', importance: 0.9 });
    manager.addMemory({ scope: 'server', serverId: 'beta', category: 'location', content: 'Home is under a mountain', importance: 0.9 });
    manager.rememberLocation({ serverId: 'alpha', dimension: 'overworld', name: 'home', position: { x: 10, y: 64, z: 20 } });
    manager.rememberLocation({ serverId: 'beta', dimension: 'overworld', name: 'home', position: { x: -5, y: 70, z: 3 } });
    manager.close();

    manager = new MemoryManager(new MemoryDatabase(file), directory, true);
    assert.equal(manager.getIdentity().name, 'Aster');
    const alpha = manager.retrieve('home food', 'alpha', 20).map((memory) => memory.content);
    assert(alpha.includes('Always carry food while exploring'));
    assert(alpha.includes('Home is beside a birch forest'));
    assert(!alpha.includes('Home is under a mountain'));
    assert.deepEqual(manager.recallLocation('alpha', 'overworld', 'home')?.position, { x: 10, y: 64, z: 20 });
    assert.deepEqual(manager.recallLocation('beta', 'overworld', 'home')?.position, { x: -5, y: 70, z: 3 });
    manager.close();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('goals and daily journals persist', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-ai-journal-'));
  try {
    const manager = new MemoryManager(new MemoryDatabase(path.join(directory, 'memory.sqlite')), directory, true);
    const goal = manager.setGoal({ description: 'Acquire iron armor', priority: 80, scope: 'server', serverId: 'alpha' });
    assert.equal(manager.getGoals('alpha')[0]?.id, goal.id);
    await manager.createJournalEntry({ serverId: 'alpha', day: 18, summary: 'Found diamonds.', importantEvents: ['Found diamonds'], lessons: ['Carry a shield'], goals: ['Get obsidian'] });
    assert.equal(manager.listJournal('alpha')[0]?.day, 18);
    assert.match(await fs.readFile(path.join(directory, 'journals', 'alpha-day-18.md'), 'utf8'), /Found diamonds/);
    manager.close();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

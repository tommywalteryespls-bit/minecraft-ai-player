import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pino from 'pino';
import type { AppConfig } from '../src/config.js';
import { ActionScheduler } from '../src/core/actionScheduler.js';
import { TestMinecraftAgent } from '../src/minecraft/adapters/test/TestMinecraftAgent.js';
import { MemoryDatabase } from '../src/memory/database.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { ProfileCommandAdapter } from '../src/server/adapters/ProfileCommandAdapter.js';
import { capabilitiesFor } from '../src/server/serverCapabilities.js';
import { ToolExecutor } from '../src/ai/toolExecutor.js';
import { ServerProfileSchema } from '../src/minecraft/serverProfiles/profileTypes.js';

test('tool executor validates and routes semantic actions through MinecraftAgent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-ai-tools-'));
  try {
    const minecraft = new TestMinecraftAgent('test-server');
    await minecraft.connect();
    const memory = new MemoryManager(new MemoryDatabase(path.join(directory, 'memory.sqlite')), directory, true);
    const logger = pino({ level: 'silent' });
    const profile = ServerProfileSchema.parse({
      id: 'test-server',
      name: 'Test',
      host: 'localhost',
      controller: 'test',
      extensions: { semanticActions: { inspect_market: { type: 'chat-command', command: '/ah' } } }
    });
    const capabilities = capabilitiesFor(profile);
    const scheduler = new ActionScheduler(minecraft, logger);
    const config = { actionTimeoutMs: 5000 } as AppConfig;
    const executor = new ToolExecutor(minecraft, memory, scheduler, capabilities, new ProfileCommandAdapter(profile, minecraft), config);

    const collected = await executor.execute('collect_resource', JSON.stringify({ resource: 'oak_log', amount: 4 }));
    assert.equal(collected.success, true);
    assert.equal(collected.data?.collected, 4);

    const invalid = await executor.execute('move_to', JSON.stringify({ position: { x: 'bad', y: 64, z: 0 }, timeout_ms: null }));
    assert.equal(invalid.success, false);

    const forbidden = await executor.execute('execute_shell', JSON.stringify({ command: 'whoami' }));
    assert.equal(forbidden.success, false);

    const rawCommand = await executor.execute('say', JSON.stringify({ message: '/op somebody' }));
    assert.equal(rawCommand.success, false);

    const configuredCommand = await executor.execute('server_action', JSON.stringify({ action: 'inspect_market', arguments: {} }));
    assert.equal(configuredCommand.success, true);

    const goal = await executor.execute('set_goal', JSON.stringify({ description: 'Build a shelter', priority: 50, scope: 'server', notes: '' }));
    assert.equal(goal.success, true);
    assert.equal(memory.getGoals('test-server').length, 1);
    await scheduler.stop();
    memory.close();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('cancelled browser tools queued behind a reflex never start later', async () => {
  const minecraft = new TestMinecraftAgent('test-server'); await minecraft.connect();
  const scheduler = new ActionScheduler(minecraft, pino({ level: 'silent' }));
  let release!: () => void;
  const blocker = scheduler.schedule('reflex', 'INTERACTING', 90, 5000, async () => {
    await new Promise<void>((resolve) => { release = resolve; }); return { success: true, action: 'reflex' };
  });
  let follows = 0;
  minecraft.followPlayer = async () => { follows++; return { success: true, action: 'follow_player' }; };
  type Args = ConstructorParameters<typeof ToolExecutor>;
  const executor = new ToolExecutor(minecraft, { recordAction: () => {} } as unknown as Args[1], scheduler, {} as Args[3], {} as Args[4], { actionTimeoutMs: 1000 } as AppConfig);
  const controller = new AbortController();
  const follow = executor.execute('follow_player', JSON.stringify({ username: 'TestPlayer' }), controller.signal);
  controller.abort(); release(); await blocker;
  const result = await follow;
  assert.equal(result.success, false); assert.match(result.reason!, /cancelled/); assert.equal(follows, 0);
  await scheduler.stop(); await minecraft.disconnect();
});

test('Fabric tools advertise only implemented actions and validate bounded client input', async () => {
  const minecraft = new TestMinecraftAgent('test-server') as TestMinecraftAgent & { supportedActions: string[]; controlPlayer(request: unknown): Promise<{ success: boolean; action: string }> };
  minecraft.supportedActions = ['control_player', 'look_at'];
  const controls: unknown[] = [];
  minecraft.controlPlayer = async (request) => { controls.push(request); return { success: true, action: 'control_player' }; };
  await minecraft.connect();
  const scheduler = new ActionScheduler(minecraft, pino({ level: 'silent' }));
  type Args = ConstructorParameters<typeof ToolExecutor>;
  const executor = new ToolExecutor(minecraft, { recordAction() {} } as unknown as Args[1], scheduler, {} as Args[3], {} as Args[4], { actionTimeoutMs: 1000 } as AppConfig);
  assert.equal(executor.availableToolNames().includes('craft_item'), false);
  assert.equal((await executor.execute('control_player', '{"command":"walk","direction":"forward","duration_ms":500}')).success, true);
  assert.equal((await executor.execute('control_player', '{"command":"walk","duration_ms":600000}')).success, false);
  assert.equal((await executor.execute('craft_item', '{"item":"oak_planks","amount":4}')).success, false);
  assert.equal(controls.length, 1);
  assert.equal((await executor.execute('control_player', '{"command":"stop"}')).success, true);
  assert.equal(controls.length, 2); await scheduler.stop(); await minecraft.disconnect();
});

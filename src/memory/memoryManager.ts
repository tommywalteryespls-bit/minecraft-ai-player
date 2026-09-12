import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActionResult, Position, WorldState } from '../minecraft/types.js';
import { MemoryDatabase } from './database.js';
import type { GoalRecord, JournalEntry, LocationRecord, MemoryRecord, PlayerRecord } from './types.js';

interface MemoryRow {
  id: string;
  scope: 'global' | 'server';
  server_id: string | null;
  category: string;
  content: string;
  importance: number;
  metadata_json: string;
  created_at: string;
}

interface GoalRow {
  id: string;
  scope: 'global' | 'server';
  server_id: string | null;
  description: string;
  priority: number;
  status: GoalRecord['status'];
  notes: string;
  created_at: string;
  completed_at: string | null;
}

interface LocationRow {
  id: string;
  server_id: string;
  dimension: string;
  name: string;
  x: number;
  y: number;
  z: number;
  description: string;
  importance: number;
}

interface PlayerRow {
  server_id: string;
  username: string;
  uuid: string | null;
  relationship_summary: string;
  important_interactions_json: string;
  first_seen: string;
  last_seen: string;
}

export class MemoryManager {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly dataDir: string,
    readonly enabled: boolean
  ) {}

  close(): void {
    this.database.close();
  }

  setIdentity(key: string, value: string): void {
    if (!this.enabled) return;
    this.database.connection
      .prepare(
        `INSERT INTO identity(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }

  getIdentity(): Record<string, string> {
    if (!this.enabled) return {};
    const rows = this.database.connection.prepare('SELECT key, value FROM identity').all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  addMemory(input: {
    scope: 'global' | 'server';
    serverId?: string;
    category: string;
    content: string;
    importance?: number;
    metadata?: Record<string, unknown>;
  }): string {
    const id = randomUUID();
    if (!this.enabled) return id;
    if (input.scope === 'server' && !input.serverId) throw new Error('Server memories require serverId');
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO memories(id, scope, server_id, category, content, importance, metadata_json, created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.scope,
        input.scope === 'server' ? input.serverId : null,
        input.category,
        input.content,
        Math.max(0, Math.min(1, input.importance ?? 0.5)),
        JSON.stringify(input.metadata ?? {}),
        now,
        now
      );
    return id;
  }

  retrieve(query: string, serverId: string, limit = 12): MemoryRecord[] {
    if (!this.enabled) return [];
    const rows = this.database.connection
      .prepare(
        `SELECT id, scope, server_id, category, content, importance, metadata_json, created_at
         FROM memories
         WHERE scope = 'global' OR (scope = 'server' AND server_id = ?)
         ORDER BY created_at DESC LIMIT 300`
      )
      .all(serverId) as MemoryRow[];
    const terms = tokenize(query);
    const now = Date.now();
    const scored = rows.map((row) => {
      const haystack = new Set(tokenize(`${row.category} ${row.content}`));
      const overlap = terms.length === 0 ? 0 : terms.filter((term) => haystack.has(term)).length / terms.length;
      const ageDays = Math.max(0, (now - Date.parse(row.created_at)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 30);
      const relevance = overlap * 0.55 + row.importance * 0.35 + recency * 0.1;
      return { row, relevance };
    });
    const selected = scored.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
    const touch = this.database.connection.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?');
    const touchedAt = new Date().toISOString();
    for (const item of selected) touch.run(touchedAt, item.row.id);
    return selected.map(({ row, relevance }) => ({
      id: row.id,
      scope: row.scope,
      serverId: row.server_id,
      category: row.category,
      content: row.content,
      importance: row.importance,
      metadata: parseObject(row.metadata_json),
      createdAt: row.created_at,
      relevance
    }));
  }

  setGoal(input: {
    description: string;
    priority: number;
    scope: 'global' | 'server';
    serverId?: string;
    notes?: string;
  }): GoalRecord {
    if (input.scope === 'server' && !input.serverId) throw new Error('Server goals require serverId');
    const goal: GoalRecord = {
      id: randomUUID(),
      scope: input.scope,
      serverId: input.scope === 'server' ? (input.serverId ?? null) : null,
      description: input.description,
      priority: Math.max(1, Math.min(100, input.priority)),
      status: 'active',
      notes: input.notes ?? '',
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    if (this.enabled) {
      this.database.connection
        .prepare(
          `INSERT INTO goals(id, scope, server_id, description, priority, status, notes, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          goal.id,
          goal.scope,
          goal.serverId,
          goal.description,
          goal.priority,
          goal.status,
          goal.notes,
          goal.createdAt,
          goal.completedAt
        );
    }
    return goal;
  }

  updateGoal(id: string, status: GoalRecord['status'], notes?: string): GoalRecord | null {
    if (!this.enabled) return null;
    const completedAt = status === 'active' ? null : new Date().toISOString();
    const result = this.database.connection
      .prepare(
        `UPDATE goals SET status = ?, notes = COALESCE(?, notes), completed_at = ? WHERE id = ?`
      )
      .run(status, notes ?? null, completedAt, id);
    return result.changes > 0 ? this.getGoal(id) : null;
  }

  getGoals(serverId: string, includeClosed = false): GoalRecord[] {
    if (!this.enabled) return [];
    const statusClause = includeClosed ? '' : "AND status = 'active'";
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM goals WHERE (scope = 'global' OR server_id = ?) ${statusClause}
         ORDER BY priority DESC, created_at ASC`
      )
      .all(serverId) as GoalRow[];
    return rows.map(mapGoal);
  }

  rememberLocation(input: {
    serverId: string;
    dimension: string;
    name: string;
    position: Position;
    description?: string;
    importance?: number;
  }): LocationRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    if (this.enabled) {
      this.database.connection
        .prepare(
          `INSERT INTO locations(id, server_id, dimension, name, x, y, z, description, importance, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(server_id, dimension, name) DO UPDATE SET
             x = excluded.x, y = excluded.y, z = excluded.z,
             description = excluded.description, importance = excluded.importance, updated_at = excluded.updated_at`
        )
        .run(
          id,
          input.serverId,
          input.dimension,
          input.name,
          input.position.x,
          input.position.y,
          input.position.z,
          input.description ?? '',
          input.importance ?? 0.5,
          now,
          now
        );
    }
    return this.recallLocation(input.serverId, input.dimension, input.name) ?? {
      id,
      serverId: input.serverId,
      dimension: input.dimension,
      name: input.name,
      position: input.position,
      description: input.description ?? '',
      importance: input.importance ?? 0.5
    };
  }

  recallLocation(serverId: string, dimension: string, name: string): LocationRecord | null {
    if (!this.enabled) return null;
    const row = this.database.connection
      .prepare('SELECT * FROM locations WHERE server_id = ? AND dimension = ? AND name = ? COLLATE NOCASE')
      .get(serverId, dimension, name) as LocationRow | undefined;
    return row ? mapLocation(row) : null;
  }

  listLocations(serverId: string, dimension?: string): LocationRecord[] {
    if (!this.enabled) return [];
    const rows = dimension
      ? (this.database.connection
          .prepare('SELECT * FROM locations WHERE server_id = ? AND dimension = ? ORDER BY importance DESC')
          .all(serverId, dimension) as LocationRow[])
      : (this.database.connection
          .prepare('SELECT * FROM locations WHERE server_id = ? ORDER BY importance DESC')
          .all(serverId) as LocationRow[]);
    return rows.map(mapLocation);
  }

  touchPlayer(input: {
    serverId: string;
    username: string;
    uuid?: string;
    interaction?: string;
    relationshipSummary?: string;
  }): PlayerRecord {
    const now = new Date().toISOString();
    const previous = this.getPlayer(input.serverId, input.username);
    const interactions = [...(previous?.importantInteractions ?? [])];
    if (input.interaction) interactions.push(input.interaction);
    const trimmed = interactions.slice(-25);
    if (this.enabled) {
      this.database.connection
        .prepare(
          `INSERT INTO players(server_id, username, uuid, relationship_summary, important_interactions_json, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(server_id, username) DO UPDATE SET
             uuid = COALESCE(excluded.uuid, players.uuid),
             relationship_summary = CASE WHEN excluded.relationship_summary = '' THEN players.relationship_summary ELSE excluded.relationship_summary END,
             important_interactions_json = excluded.important_interactions_json,
             last_seen = excluded.last_seen`
        )
        .run(
          input.serverId,
          input.username,
          input.uuid ?? null,
          input.relationshipSummary ?? previous?.relationshipSummary ?? '',
          JSON.stringify(trimmed),
          previous?.firstSeen ?? now,
          now
        );
    }
    return this.getPlayer(input.serverId, input.username) ?? {
      serverId: input.serverId,
      username: input.username,
      uuid: input.uuid ?? null,
      relationshipSummary: input.relationshipSummary ?? '',
      importantInteractions: trimmed,
      firstSeen: now,
      lastSeen: now
    };
  }

  getPlayer(serverId: string, username: string): PlayerRecord | null {
    if (!this.enabled) return null;
    const row = this.database.connection
      .prepare('SELECT * FROM players WHERE server_id = ? AND username = ? COLLATE NOCASE')
      .get(serverId, username) as PlayerRow | undefined;
    return row ? mapPlayer(row) : null;
  }

  recordEvent(input: {
    serverId: string;
    type: string;
    summary: string;
    importance?: number;
    day?: number;
    data?: Record<string, unknown>;
  }): void {
    if (!this.enabled) return;
    this.database.connection
      .prepare(
        `INSERT INTO events(id, server_id, type, summary, importance, day, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.serverId,
        input.type,
        input.summary,
        input.importance ?? 0.5,
        input.day ?? null,
        JSON.stringify(input.data ?? {}),
        new Date().toISOString()
      );
  }

  recentEvents(serverId: string, limit = 20, day?: number): string[] {
    if (!this.enabled) return [];
    const rows = day === undefined
      ? (this.database.connection
          .prepare('SELECT summary FROM events WHERE server_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(serverId, limit) as Array<{ summary: string }>)
      : (this.database.connection
          .prepare('SELECT summary FROM events WHERE server_id = ? AND day = ? ORDER BY created_at ASC LIMIT ?')
          .all(serverId, day, limit) as Array<{ summary: string }>);
    return rows.map((row) => row.summary);
  }

  recordAction(input: {
    serverId: string;
    action: string;
    arguments: Record<string, unknown>;
    result: ActionResult;
    startedAt: string;
  }): void {
    if (!this.enabled) return;
    this.database.connection
      .prepare(
        `INSERT INTO actions(id, server_id, action, arguments_json, result_json, success, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.serverId,
        input.action,
        JSON.stringify(input.arguments),
        JSON.stringify(input.result),
        input.result.success ? 1 : 0,
        input.startedAt,
        new Date().toISOString()
      );
  }

  recordConversation(input: {
    serverId: string;
    username?: string;
    channel: 'text' | 'voice';
    direction: 'incoming' | 'outgoing';
    message: string;
    day?: number;
  }): void {
    if (!this.enabled) return;
    this.database.connection
      .prepare(
        `INSERT INTO conversations(id, server_id, username, channel, direction, message, day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.serverId,
        input.username ?? null,
        input.channel,
        input.direction,
        input.message,
        input.day ?? null,
        new Date().toISOString()
      );
  }

  recentConversations(serverId: string, username?: string, limit = 12): string[] {
    if (!this.enabled) return [];
    const rows = username
      ? (this.database.connection
          .prepare(
            `SELECT direction, username, message FROM conversations
             WHERE server_id = ? AND username = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`
          )
          .all(serverId, username, limit) as Array<{ direction: string; username: string | null; message: string }>)
      : (this.database.connection
          .prepare(
            `SELECT direction, username, message FROM conversations
             WHERE server_id = ? ORDER BY created_at DESC LIMIT ?`
          )
          .all(serverId, limit) as Array<{ direction: string; username: string | null; message: string }>);
    return rows.reverse().map((row) => `${row.direction === 'incoming' ? row.username ?? 'player' : 'AI'}: ${row.message}`);
  }

  recordDeath(state: WorldState, cause: string): void {
    if (!this.enabled) return;
    this.database.connection
      .prepare(
        `INSERT INTO deaths(id, server_id, dimension, x, y, z, cause, day, inventory_json, threats_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        state.serverId,
        state.dimension,
        state.position.x,
        state.position.y,
        state.position.z,
        cause,
        state.day,
        JSON.stringify(state.inventory.items),
        JSON.stringify(state.environmentalThreats),
        new Date().toISOString()
      );
  }

  async createJournalEntry(entry: JournalEntry): Promise<void> {
    if (!this.enabled) return;
    this.database.connection
      .prepare(
        `INSERT INTO journal_entries(id, server_id, day, summary, important_events_json, lessons_json, goals_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id, day) DO UPDATE SET
           summary = excluded.summary,
           important_events_json = excluded.important_events_json,
           lessons_json = excluded.lessons_json,
           goals_json = excluded.goals_json`
      )
      .run(
        randomUUID(),
        entry.serverId,
        entry.day,
        entry.summary,
        JSON.stringify(entry.importantEvents),
        JSON.stringify(entry.lessons),
        JSON.stringify(entry.goals),
        new Date().toISOString()
      );
    const directory = path.join(this.dataDir, 'journals');
    await fs.mkdir(directory, { recursive: true });
    const markdown = [
      `# Day ${entry.day}`,
      '',
      entry.summary,
      '',
      '## Important events',
      '',
      ...(entry.importantEvents.length ? entry.importantEvents.map((event) => `- ${event}`) : ['- None recorded']),
      '',
      '## Lessons',
      '',
      ...(entry.lessons.length ? entry.lessons.map((lesson) => `- ${lesson}`) : ['- None recorded']),
      '',
      '## Current goals',
      '',
      ...(entry.goals.length ? entry.goals.map((goal) => `- ${goal}`) : ['- None']),
      ''
    ].join('\n');
    await fs.writeFile(path.join(directory, `${safeFilename(entry.serverId)}-day-${entry.day}.md`), markdown, 'utf8');
  }

  listJournal(serverId: string, limit = 10): JournalEntry[] {
    if (!this.enabled) return [];
    const rows = this.database.connection
      .prepare(
        `SELECT server_id, day, summary, important_events_json, lessons_json, goals_json
         FROM journal_entries WHERE server_id = ? ORDER BY day DESC LIMIT ?`
      )
      .all(serverId, limit) as Array<{
      server_id: string;
      day: number;
      summary: string;
      important_events_json: string;
      lessons_json: string;
      goals_json: string;
    }>;
    return rows.map((row) => ({
      serverId: row.server_id,
      day: row.day,
      summary: row.summary,
      importantEvents: parseStringArray(row.important_events_json),
      lessons: parseStringArray(row.lessons_json),
      goals: parseStringArray(row.goals_json)
    }));
  }

  getExperimentStats(serverId: string): Record<string, unknown> {
    if (!this.enabled) return {};
    const db = this.database.connection;
    const deaths = (db.prepare('SELECT COUNT(*) count FROM deaths WHERE server_id = ?').get(serverId) as { count: number }).count;
    const actions = db
      .prepare('SELECT COUNT(*) total, SUM(success) succeeded FROM actions WHERE server_id = ?')
      .get(serverId) as { total: number; succeeded: number | null };
    const conversations = (
      db.prepare('SELECT COUNT(*) count FROM conversations WHERE server_id = ?').get(serverId) as { count: number }
    ).count;
    const journals = (db.prepare('SELECT COUNT(*) count FROM journal_entries WHERE server_id = ?').get(serverId) as { count: number }).count;
    return { deaths, actions: actions.total, successfulActions: actions.succeeded ?? 0, conversations, journalDays: journals };
  }

  private getGoal(id: string): GoalRecord | null {
    const row = this.database.connection.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
    return row ? mapGoal(row) : null;
  }
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapGoal(row: GoalRow): GoalRecord {
  return {
    id: row.id,
    scope: row.scope,
    serverId: row.server_id,
    description: row.description,
    priority: row.priority,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function mapLocation(row: LocationRow): LocationRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    dimension: row.dimension,
    name: row.name,
    position: { x: row.x, y: row.y, z: row.z },
    description: row.description,
    importance: row.importance
  };
}

function mapPlayer(row: PlayerRow): PlayerRecord {
  return {
    serverId: row.server_id,
    username: row.username,
    uuid: row.uuid,
    relationshipSummary: row.relationship_summary,
    importantInteractions: parseStringArray(row.important_interactions_json),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen
  };
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

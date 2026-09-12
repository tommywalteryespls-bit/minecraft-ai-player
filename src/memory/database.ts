import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class MemoryDatabase {
  readonly connection: Database.Database;

  constructor(databaseFile: string) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.connection = new Database(databaseFile);
    this.connection.pragma('journal_mode = WAL');
    this.connection.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    if (this.connection.open) this.connection.close();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS identity (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'server')),
        server_id TEXT,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope_server ON memories(scope, server_id);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

      CREATE TABLE IF NOT EXISTS players (
        server_id TEXT NOT NULL,
        username TEXT NOT NULL,
        uuid TEXT,
        relationship_summary TEXT NOT NULL DEFAULT '',
        important_interactions_json TEXT NOT NULL DEFAULT '[]',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY(server_id, username)
      );

      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        name TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(server_id, dimension, name)
      );

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'server')),
        server_id TEXT,
        description TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed', 'abandoned')),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_goals_active ON goals(status, server_id, priority DESC);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        day INTEGER,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_server_day ON events(server_id, day, created_at DESC);

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        action TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        success INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        username TEXT,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
        message TEXT NOT NULL,
        day INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deaths (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL,
        cause TEXT NOT NULL,
        day INTEGER NOT NULL,
        inventory_json TEXT NOT NULL,
        threats_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS journal_entries (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        day INTEGER NOT NULL,
        summary TEXT NOT NULL,
        important_events_json TEXT NOT NULL,
        lessons_json TEXT NOT NULL,
        goals_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(server_id, day)
      );
    `);
  }
}

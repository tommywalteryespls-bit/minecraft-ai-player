import type { Position } from '../minecraft/types.js';

export interface MemoryRecord {
  id: string;
  scope: 'global' | 'server';
  serverId: string | null;
  category: string;
  content: string;
  importance: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  relevance: number;
}

export interface GoalRecord {
  id: string;
  scope: 'global' | 'server';
  serverId: string | null;
  description: string;
  priority: number;
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  notes: string;
  createdAt: string;
  completedAt: string | null;
}

export interface LocationRecord {
  id: string;
  serverId: string;
  dimension: string;
  name: string;
  position: Position;
  description: string;
  importance: number;
}

export interface PlayerRecord {
  serverId: string;
  username: string;
  uuid: string | null;
  relationshipSummary: string;
  importantInteractions: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface JournalEntry {
  serverId: string;
  day: number;
  summary: string;
  importantEvents: string[];
  lessons: string[];
  goals: string[];
}

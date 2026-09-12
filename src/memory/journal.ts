import type { MemoryManager } from './memoryManager.js';
import type { JournalEntry } from './types.js';

export class JournalService {
  constructor(private readonly memory: MemoryManager) {}

  async closeDay(serverId: string, day: number, summary?: string, lessons: string[] = []): Promise<JournalEntry> {
    const events = this.memory.recentEvents(serverId, 50, day);
    const goals = this.memory.getGoals(serverId).map((goal) => goal.description);
    const entry: JournalEntry = {
      serverId,
      day,
      summary: summary ?? (events.length ? `Day ${day}: ${events.slice(0, 5).join('; ')}` : `Day ${day} passed quietly.`),
      importantEvents: events.slice(0, 15),
      lessons,
      goals
    };
    await this.memory.createJournalEntry(entry);
    return entry;
  }
}

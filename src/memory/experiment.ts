import fs from 'node:fs/promises';
import path from 'node:path';
import type { OpenAIService } from '../ai/openai.js';
import type { Logger } from 'pino';
import type { MemoryManager } from './memoryManager.js';

export class ExperimentTracker {
  constructor(
    private readonly memory: MemoryManager,
    private readonly openai: OpenAIService,
    private readonly dataDir: string,
    private readonly model: string,
    private readonly logger: Logger
  ) {}

  async finish100Days(serverId: string): Promise<string | null> {
    const directory = path.join(this.dataDir, 'experiments');
    const file = path.join(directory, `${safeFilename(serverId)}-100-days.md`);
    try {
      await fs.access(file);
      return file;
    } catch {
      // Generate once.
    }
    const journals = this.memory.listJournal(serverId, 100).sort((a, b) => a.day - b.day);
    if (journals.length < 100) return null;
    const stats = this.memory.getExperimentStats(serverId);
    let reflection = 'The experiment reached 100 recorded Minecraft days.';
    if (this.openai.enabled) {
      try {
        const response = await this.openai.requireClient().responses.create({
          model: this.model,
          instructions: 'Write a concise first-person final reflection for a 100-day Minecraft AI experiment. Use only supplied facts.',
          input: JSON.stringify({ stats, journals }),
          max_output_tokens: 1800
        });
        reflection = response.output_text.trim() || reflection;
      } catch (error) {
        this.logger.warn({ error }, 'Could not generate model-written 100-day reflection; using deterministic summary');
      }
    }
    await fs.mkdir(directory, { recursive: true });
    const markdown = [
      `# ${serverId}: 100-day experiment`,
      '',
      '## Final reflection',
      '',
      reflection,
      '',
      '## Statistics',
      '',
      '```json',
      JSON.stringify(stats, null, 2),
      '```',
      '',
      '## Daily journal',
      '',
      ...journals.flatMap((entry) => [
        `### Day ${entry.day}`,
        '',
        entry.summary,
        '',
        ...entry.importantEvents.map((event) => `- ${event}`),
        ''
      ])
    ].join('\n');
    await fs.writeFile(file, markdown, 'utf8');
    return file;
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

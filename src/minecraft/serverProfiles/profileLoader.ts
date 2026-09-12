import fs from 'node:fs/promises';
import path from 'node:path';
import { ServerProfileSchema, type ServerProfile } from './profileTypes.js';

export class ServerProfileLoader {
  constructor(private readonly serversDir: string) {}

  async list(): Promise<ServerProfile[]> {
    const entries = await fs.readdir(this.serversDir, { withFileTypes: true });
    const profiles: ServerProfile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const candidate = await this.readFile(path.join(this.serversDir, entry.name));
      profiles.push(candidate);
    }
    const seen = new Set<string>();
    for (const profile of profiles) {
      if (seen.has(profile.id)) throw new Error(`Duplicate server profile id '${profile.id}' in ${this.serversDir}`);
      seen.add(profile.id);
    }
    return profiles.sort((a, b) => a.id.localeCompare(b.id));
  }

  async load(id: string): Promise<ServerProfile> {
    const profiles = await this.list();
    const profile = profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      throw new Error(
        `Server profile '${id}' was not found in ${this.serversDir}. Available: ${profiles.map((p) => p.id).join(', ') || '(none)'}`
      );
    }
    return profile;
  }

  private async readFile(file: string): Promise<ServerProfile> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not parse server profile ${file}: ${String(error)}`);
    }
    const result = ServerProfileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid server profile ${file}: ${result.error.message}`);
    }
    return result.data;
  }
}

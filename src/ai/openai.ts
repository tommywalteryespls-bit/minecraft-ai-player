import OpenAI from 'openai';
import type { AppConfig } from '../config.js';

export class OpenAIService {
  readonly client: OpenAI | null;

  constructor(readonly config: AppConfig) {
    this.client = config.openaiApiKey
      ? new OpenAI({ apiKey: config.openaiApiKey, timeout: 60_000, maxRetries: 3 })
      : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  requireClient(): OpenAI {
    if (!this.client) throw new Error('OPENAI_API_KEY is required when autonomous or voice AI is enabled');
    return this.client;
  }
}

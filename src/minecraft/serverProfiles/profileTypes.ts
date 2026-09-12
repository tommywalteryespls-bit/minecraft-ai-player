import { z } from 'zod';

export const ServerProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(25565),
  version: z.union([z.literal('auto'), z.string().min(1)]).default('auto'),
  auth: z.enum(['microsoft', 'offline']).optional(),
  controller: z.enum(['mineflayer', 'fabric', 'test']).default('mineflayer'),
  capabilities: z
    .object({
      voiceChat: z.boolean().default(false),
      customEconomy: z.boolean().default(false),
      customMenus: z.boolean().default(false),
      textChat: z.boolean().default(true)
    })
    .default({ voiceChat: false, customEconomy: false, customMenus: false, textChat: true }),
  behavior: z
    .object({
      autonomous: z.boolean().default(true),
      allowCombat: z.boolean().default(true),
      allowBlockBreaking: z.boolean().default(true),
      allowBlockPlacement: z.boolean().default(true),
      textChatFallback: z.boolean().default(true)
    })
    .default({
      autonomous: true,
      allowCombat: true,
      allowBlockBreaking: true,
      allowBlockPlacement: true,
      textChatFallback: true
    }),
  reconnect: z
    .object({
      enabled: z.boolean().default(true),
      maxAttempts: z.number().int().min(0).max(20).optional(),
      baseDelayMs: z.number().int().min(500).optional()
    })
    .default({ enabled: true }),
  extensions: z
    .object({
      semanticActions: z.record(
        z.string(),
        z.object({
          type: z.literal('chat-command'),
          command: z.string().startsWith('/'),
          description: z.string().optional()
        })
      )
    })
    .optional()
});

export type ServerProfile = z.infer<typeof ServerProfileSchema>;

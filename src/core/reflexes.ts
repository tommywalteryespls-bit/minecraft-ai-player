import type { Logger } from 'pino';
import type { MinecraftAgent } from '../minecraft/MinecraftAgent.js';
import type { PerceivedEntity } from '../minecraft/types.js';
import { ActionScheduler } from './actionScheduler.js';

export class ReflexController {
  private timer: NodeJS.Timeout | null = null;
  private acting = false;

  constructor(
    private readonly minecraft: MinecraftAgent,
    private readonly scheduler: ActionScheduler,
    private readonly logger: Logger,
    private readonly enabled: boolean
  ) {}

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void this.check(), 750);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async check(): Promise<void> {
    if (this.acting || !this.minecraft.connected) return;
    this.acting = true;
    try {
      const state = await this.minecraft.getWorldState();
      const closest = state.nearbyHostiles[0];
      const creeper = state.nearbyHostiles.find((entity) => entity.name.includes('creeper') && entity.distance <= 5);
      const urgentThreat = creeper ?? (state.health <= 6 ? closest : undefined);
      if (urgentThreat) {
        await this.flee(urgentThreat);
        return;
      }
      const criticalEnvironment = state.environmentalThreats.find((threat) => threat.severity === 'critical');
      if (criticalEnvironment && closest) {
        await this.flee(closest);
        return;
      }
      if (state.hunger <= 6 && state.inventory.items.some((item) => isFood(item.name))) {
        this.logger.warn({ serverId: state.serverId, hunger: state.hunger }, 'Reflex: eating available food');
        await this.scheduler.schedule('reflex_eat', 'EATING', 100, 12_000, () => this.minecraft.eatBestFood());
      }
    } catch (error) {
      this.logger.debug({ error }, 'Reflex check could not inspect state');
    } finally {
      this.acting = false;
    }
  }

  private async flee(threat: PerceivedEntity): Promise<void> {
    this.logger.warn({ threat: threat.name, distance: threat.distance }, 'Reflex: fleeing immediate danger');
    await this.scheduler.schedule('reflex_flee', 'FLEEING', 110, 15_000, () => this.minecraft.fleeFrom(threat.id));
  }
}

function isFood(name: string): boolean {
  return /bread|apple|carrot|potato|beef|porkchop|chicken|mutton|rabbit|cod|salmon|melon|berry|stew|pie/.test(name);
}

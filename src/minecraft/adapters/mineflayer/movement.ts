import type { Bot } from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { ActionResult, MoveOptions, Position } from '../../types.js';
import { withTimeout } from '../../../utils/timeout.js';

const { goals, Movements } = pathfinderPackage;
const { GoalNear, GoalFollow, GoalGetToBlock } = goals;

export class MovementController {
  constructor(
    private readonly bot: Bot,
    private readonly defaultTimeoutMs: number
  ) {}

  configure(options: MoveOptions = {}): void {
    const movements = new Movements(this.bot);
    movements.canDig = options.canDig ?? false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    this.bot.pathfinder.setMovements(movements);
  }

  async moveNear(position: Position, radius: number, options: MoveOptions = {}): Promise<ActionResult> {
    this.configure(options);
    const goal = new GoalNear(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z), radius);
    await withTimeout(
      this.bot.pathfinder.goto(goal),
      options.timeoutMs ?? this.defaultTimeoutMs,
      'move_near',
      () => this.cancel()
    );
    if (options.sprint) this.bot.setControlState('sprint', false);
    return { success: true, action: 'move_near', finalPosition: toPosition(this.bot.entity.position) };
  }

  async moveTo(position: Position, options: MoveOptions = {}): Promise<ActionResult> {
    return this.moveNear(position, 0, options).then((result) => ({ ...result, action: 'move_to' }));
  }

  follow(entity: NonNullable<Bot['entity']>, radius = 2): void {
    this.configure({ canDig: false });
    this.bot.pathfinder.setGoal(new GoalFollow(entity, radius), true);
  }

  async getAdjacentTo(position: Position, timeoutMs = this.defaultTimeoutMs): Promise<void> {
    this.configure({ canDig: false });
    await withTimeout(
      this.bot.pathfinder.goto(
        new GoalGetToBlock(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
      ),
      timeoutMs,
      'move_adjacent',
      () => this.cancel()
    );
  }

  cancel(): void {
    this.bot.pathfinder.setGoal(null);
    this.bot.clearControlStates();
  }

  async fleeFrom(threat: Position, distance = 14): Promise<ActionResult> {
    const current = this.bot.entity.position;
    const delta = current.minus(new Vec3(threat.x, threat.y, threat.z));
    const length = Math.max(0.001, Math.sqrt(delta.x ** 2 + delta.z ** 2));
    const target = {
      x: current.x + (delta.x / length) * distance,
      y: current.y,
      z: current.z + (delta.z / length) * distance
    };
    const result = await this.moveNear(target, 2, { canDig: false, timeoutMs: 15_000, sprint: true });
    return { ...result, action: 'flee', data: { threat, target } };
  }
}

export function toPosition(value: { x: number; y: number; z: number }): Position {
  return { x: round(value.x), y: round(value.y), z: round(value.z) };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

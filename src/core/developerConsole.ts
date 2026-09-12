import readline from 'node:readline';
import type { AgentApplication } from './application.js';

export class DeveloperConsole {
  private interface: readline.Interface | null = null;

  constructor(
    private readonly application: AgentApplication,
    private readonly onShutdown: () => Promise<void>
  ) {}

  start(): void {
    if (!process.stdin.isTTY) return;
    this.interface = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'minecraft-ai> ' });
    this.interface.on('line', (line) => void this.handle(line.trim()).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
    }).finally(() => this.interface?.prompt()));
    this.interface.on('close', () => void this.onShutdown());
    this.interface.prompt();
  }

  close(): void {
    this.interface?.close();
    this.interface = null;
  }

  private async handle(line: string): Promise<void> {
    const [command = '', ...args] = line.split(/\s+/);
    switch (command.toLowerCase()) {
      case 'status':
      case 'state':
        print(await this.application.state());
        break;
      case 'goals':
        print(this.application.memory.getGoals(this.requireServer(), true));
        break;
      case 'memories':
        print(this.application.memory.retrieve(args.join(' ') || 'important recent memories', this.requireServer(), 20));
        break;
      case 'server':
        print({ serverId: this.application.currentServerId });
        break;
      case 'servers':
        print((await this.application.profiles.list()).map(({ id, name, host, port, controller }) => ({ id, name, host, port, controller })));
        break;
      case 'connect':
        if (!args[0]) throw new Error('Usage: connect <server>');
        await this.application.connect(args[0]);
        break;
      case 'disconnect':
        await this.application.disconnect();
        break;
      case 'think':
        print(await this.requireAgent().thinkNow());
        break;
      case 'stop':
        this.requireAgent().setAutonomy(false);
        break;
      case 'follow':
        if (!args[0]) throw new Error('Usage: follow <username>');
        await this.requireAgent().follow(args[0]);
        break;
      case 'voice-status':
        print({ ...this.requireAgent().voiceStatus(), mode: this.application.activeVoiceMode, browserUrl: this.application.browserVoiceUrl });
        break;
      case 'voice-panel':
        console.log(this.application.browserVoiceUrl ?? 'Set VOICE_MODE=browser in .env, then restart the bot.');
        break;
      case 'voice-test':
        if (this.application.activeVoiceMode === 'browser') {
          console.log(`Browser voice is selected. Open ${this.application.browserVoiceUrl ?? 'the voice panel'} and record a message to test it.`);
          break;
        }
        console.log('Testing speech generation and Minecraft playback (uses the configured OpenAI TTS model and API credits).');
        print(await this.requireAgent().testVoice(args.join(' ') || undefined));
        break;
      case 'journal':
        print(this.application.memory.listJournal(this.requireServer(), 20));
        break;
      case 'shutdown':
      case 'exit':
      case 'quit':
        await this.onShutdown();
        break;
      case 'help':
      case '':
        console.log('status | state | goals | memories [query] | server | servers | connect <id> | disconnect | think | stop | follow <username> | voice-status | voice-panel | voice-test [message] | journal | shutdown');
        break;
      default:
        console.log(`Unknown command '${command}'. Type help.`);
    }
  }

  private requireServer(): string {
    const server = this.application.currentServerId;
    if (!server) throw new Error('Not connected to a server');
    return server;
  }

  private requireAgent() {
    const agent = this.application.currentAgent;
    if (!agent) throw new Error('No active agent');
    return agent;
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

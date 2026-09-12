# Astra Minecraft AI

An OpenAI-powered Minecraft controller with persistent memory, voice commands, Fabric player control, and an optional separate Mineflayer bot.

Use it only in worlds or servers where automation is allowed. Voice, planning, and speech use OpenAI API credits.

## Fast setup: control your own Minecraft player

### Install once

1. Install [Node.js 22 LTS](https://nodejs.org/), Java 21, Minecraft Java 1.21.11, Fabric Loader 0.18.4+, and Fabric API for 1.21.11.
2. Download this repository and open its folder in PowerShell.
3. Run:

   ```powershell
   npm.cmd install
   Copy-Item .env.example .env
   ```

4. Open `.env` and add your key:

   ```dotenv
   OPENAI_API_KEY=your_key_here
   VOICE_ENABLED=true
   VOICE_MODE=browser
   FABRIC_UNRESTRICTED=false
   ```

5. Double-click `fabric-mod\build-mod.cmd`.
6. Double-click `Setup Fabric Voice.cmd`.

For a custom Minecraft instance, run this instead of step 6:

```powershell
node scripts/setup-fabric.mjs --minecraft-dir "C:\path\to\your\instance\.minecraft"
```

### Each time you play

1. Launch the Fabric 1.21.11 profile and join a world or permitted server.
2. Run `/astra voice` in Minecraft.
3. In the browser, click **Start hands-free** and allow microphone access.
4. Return to Minecraft and press **F8** to arm voice control.
5. Speak a command and pause, for example: “Turn right 90 degrees” or “Mine the block I am looking at.”
6. Press **F9** for an immediate stop.

The mod normally starts the Node backend automatically. If it does not, double-click `Start Fabric Voice.cmd` before launching Minecraft.

## Separate Mineflayer bot

1. Set `MC_USERNAME` and `DEFAULT_SERVER` in `.env`.
2. Copy a profile in `servers`, give it a `.local.json` filename, and set its host, port, and authentication mode.
3. Run:

   ```powershell
   npm.cmd run dev
   ```

Microsoft authentication prints a device-login URL and code the first time. The project never needs your Microsoft password.

## Useful voice commands

- “Walk forward for two seconds.”
- “Mine three nearby stone blocks.”
- “Get a full set of diamond armor and equip it.”
- “Search for an underground base from here, heading east.”
- “Follow Steve.”
- “Stop.”

Fabric controls your current player, so “follow me” cannot target a separate copy of you. Name another player instead.

## Important files

- `.env` — private API and runtime settings; never commit it.
- `servers/*.local.json` — private server profiles; never commit them.
- `src` — Node/TypeScript controller.
- `fabric-mod` — Minecraft 1.21.11 client mod.
- `docs/fabric-voice.md` — detailed Fabric instructions and troubleshooting.
- `docs/base-search.md` — dedicated underground search behavior.
- `docs/mindcraft-integration.md` — item goals and gameplay abilities.

## Verify the project

```powershell
npm.cmd run typecheck
npm.cmd test
```

The browser voice panel and Fabric bridge listen only on `127.0.0.1`. Do not port-forward them. Audio submitted through the voice panel is sent to OpenAI, and transcripts may be stored locally under `data`.

The operator is responsible for server rules, API costs, account safety, recording consent, and local law.

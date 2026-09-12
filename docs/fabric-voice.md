# Play with Fabric voice control — Minecraft 1.21.11

This mode controls **your own currently logged-in Minecraft player**. It does not join with the old bot account. You join the world or server normally in Minecraft; the mod operates that player only after you press F8.

The microphone and AI voice use a local browser tab. No Simple Voice Chat mod or voice server port is required. Replies are audible to you through your headphones, not to other players. The mod still needs the project's Node backend; AI processing is not bundled into the JAR. **After installing the automatic-start update, the mod starts that backend in the background when Minecraft launches. You no longer need to open `Start Fabric Voice.cmd` each time.**

## Automatic backend startup

**One-time update:** close Minecraft and stop any manually running backend, then double-click **Setup Fabric Voice.cmd**. It rebuilds the backend, installs the newest JAR, and records this project's absolute folder and the current Node executable in your instance's `config/astra-voice.json`. Existing Astra files are backed up; unrelated mods and custom settings are preserved. Custom launchers still need the correct instance directory (see installation below).

Afterward, launch Minecraft normally. The mod starts Node directly in the background, without a PowerShell/CMD window. It reuses a compatible, authenticated backend already running on the configured ports. Closing Minecraft shuts down only the backend that this Minecraft process started; a separately started backend stays running. The microphone is **not** enabled automatically and the player remains disarmed until F8. No Windows startup task or service is installed.

Node.js and this project folder must remain on disk. The managed launcher uses the backend compiled by setup rather than compiling every time Minecraft opens. After source-code changes, run setup again; ordinary `.env` changes only need a backend restart (close/reopen Minecraft if it owns the backend). If a manually started backend is being reused, restart that backend separately.

To opt out, set `backend.autoStart` to `false` in your instance's `config/astra-voice.json`, then restart Minecraft. Setup preserves an explicit `false`. Older configs without the `backend` section retain manual startup until setup is rerun. If you move the project or replace Node at a different path, run setup again to refresh the recorded paths. Startup output goes to `logs/fabric-backend.log` in the project; `/astra status` also shows backend startup status. Startup failure is not retried endlessly; fix the reported problem, then use `/astra connect` or restart Minecraft.

## New: Mindcraft-inspired item goals

**Dedicated base search is also available:** see [the base-search guide](base-search.md). It adds persistent parallel-tunnel coverage, block-evidence scanning, per-step construction checks and explicit pause/resume. Reinstall the newest JAR before using it; searches stop at suspected structures and do not investigate/open containers.

The rebuilt mod adds ground pathfinding, resource gathering, crafting, smelting, full-inventory equipment, block placement and storage-container actions. Say **“Get a full set of diamond armor and equip it.”** The item-goal runner resolves missing tools/materials/stations and checks inventory and worn equipment before reporting completion. Say **“Stop”** or use F9; later ask to list and resume the saved goal. Reinstall the JAR using the steps below. See [the integration notes](mindcraft-integration.md) for capabilities, source attribution and limits; this is not full Mindcraft feature parity or a guarantee of finding diamonds in every world.

## Continuous control update

This project's `.env` has `FABRIC_UNRESTRICTED=true`, as requested. It removes the automatic six-round task cap, three-minute voice-turn deadline, default action deadlines, sixty-second following limit, ten-second walking ceiling, and sixty-four-block navigation cutoff **for Fabric only**. Conservative obstacle/fluid/drop/stuck checks and automatic disarming on manual input/focus loss are also disabled. The gameplay update adds ground pathfinding for coordinate navigation, but relative “walk forward” remains direct input. Neither mode bypasses Minecraft physics, normal reach, loaded-world limits or server protections.

**This update requires reinstalling the newly built mod:** close Minecraft, stop any manually started backend, double-click `Setup Fabric Voice.cmd` in the project folder, then relaunch Minecraft. Only restart the backend manually if you opted out of automatic startup. Setup backs up the old Astra JAR/config and preserves unrelated mods. For a custom game directory use the installer command below. Reload the voice panel after restarting. An older mod is explicitly rejected in unrestricted mode with an update-required message.

Start hands-free and say **“Keep mining nearby stone until I say stop”**, or **“Walk forward until I say stop”**. Say **“Stop”**, **“Astra, stop”**, or **“Stop mining”** to cancel. While processing or speaking, captured speech goes to a separate stop-only transcription path; it does not queue another task. The stop path bypasses the planner queue, cancels pending model work, and releases already-started movement/mining/following. After a recognized spoken stop the microphone stays ready for your next command. Explicit finite requests still mean what you said: “mine three blocks” ends after three, and “walk for two seconds” lasts two seconds.

Use headphones. Spoken stop requires speech detection, an end-of-speech pause, network access, and successful transcription; it is **not instantaneous or guaranteed to be heard**. Speaker echo may cause accidental stops. **F9** and the panel's **Stop actions & listening** button remain manual stop methods. F8/F9, authentication, valid sessions, death/world-exit/disconnect cleanup remain; menus temporarily pause game inputs and resume the task after closing. Reconnecting does not automatically re-arm.

There is no task spending cap. Additional reasoning rounds and speech captured for interruption detection can use API credits. Open-ended mining can continue making requests even after a model gives a progress-only reply. Local ongoing follow/walk do not themselves require repeated AI calls. API errors, context limits, missing capabilities, or broken connections can still interrupt work: this is not a guarantee of literally infinite operation. To restore the original bounded mode, set `FABRIC_UNRESTRICTED=false` in `.env` and restart the backend; `MAX_TOOL_ROUNDS` and `ACTION_TIMEOUT_MS` then apply to Fabric again.

## One-time installation

1. Close Minecraft and stop any old running bot/backend. Use a backed-up test world for your first session.
2. Select/install **Fabric for Minecraft 1.21.11** in your launcher, with Fabric Loader **0.18.4 or newer**. Do not select a different Minecraft version. See [Fabric's installation instructions](https://docs.fabricmc.net/players/installing-fabric/).
3. Put **Fabric API for 1.21.11** in that installation's `mods` folder. This project builds against [Fabric API 0.141.6+1.21.11](https://github.com/FabricMC/fabric-api/releases/tag/0.141.6%2B1.21.11). Keep only one compatible Fabric API JAR. Fabric Loader and Fabric API are different components.
4. In this project folder, double-click **Setup Fabric Voice.cmd**. The default target is `%APPDATA%\.minecraft`. It installs `astra-voice.jar` and pairs the mod with this project through `config\astra-voice.json`. It does **not** install Fabric Loader or Fabric API. Existing Astra files are backed up with a timestamp; unrelated mods are preserved. Keep just one Astra mod JAR in `mods`.
5. Keep your existing OpenAI API key and valid API model IDs in the project's `.env`, with `VOICE_ENABLED=true`. The key stays in the backend, never in the Minecraft JAR or browser. This mode uses `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_MODEL`, `OPENAI_TTS_MODEL`, and `OPENAI_VOICE`. It does not use `OPENAI_REALTIME_MODEL`. The controlled player's identity comes from Minecraft, not `MC_USERNAME` or `AI_OWNER`.

If your launcher uses a custom game directory (for example a separate Prism instance), use its actual Minecraft folder rather than the default. From this project directory, run:

```powershell
node scripts/setup-fabric.mjs --minecraft-dir "C:\path\to\your\instance\.minecraft"
```

The selected folder must already exist. If you use the official launcher with a custom Game Directory, that is the target. Do not put the mod on the Minecraft server: this is a client-only mod.

The existing project dependencies are already installed on this workspace. If copying the whole project to a new computer, install Node.js 22+ and run `npm.cmd install` once first. You do not need a development JDK or Gradle just to use the already-built JAR. Minecraft 1.21.11 itself needs Java 21; use your launcher's appropriate game runtime.

## Each time you play

1. Launch **Fabric 1.21.11** in Minecraft. With the automatic-start update installed, the local backend starts in the background with the `fabric-client` profile, browser voice, and autonomy/reflexes disabled. No CMD launcher or PowerShell command is needed. If you opted out of automatic startup or have an older mod/config, double-click **Start Fabric Voice.cmd** first and leave its window open.
2. Join a test world or a server where automation is permitted. No server address is needed in the backend: you choose it in Minecraft's Multiplayer screen.
3. In Minecraft chat, type **`/astra voice`**. This client-side command opens the local voice panel. Alternatively, open `http://127.0.0.1:3001/` in Chrome or Edge, or the exact URL printed by the backend.
4. Wait for **Minecraft connected**. Click **Start hands-free**, allow microphone access, and leave the tab open. It may say **Mic ready · Press F8 in Minecraft**. This is expected.
5. Return to Minecraft, close chat/menus, release movement keys, and press **F8**. You should see **Voice control ARMED**. Wait a couple of seconds for the browser's status poll, then speak.
6. Start with **“Turn right 90 degrees.”** Then try **“Walk forward for two seconds”**. In unrestricted mode the microphone remains active during processing/replies for spoken stop. Manual input does not disarm; use a stop command to take control back.
7. Press **F9** whenever you want an immediate local stop. It releases automated inputs and disarms the mod. F8 also toggles arming. In unrestricted mode a menu pauses/resumes the current action without disarming; in bounded mode it disarms and requires F8 again.
8. When finished, press F9, stop listening in the browser, and close Minecraft. The backend started by the mod closes automatically. A separately started backend must still be stopped with Ctrl+C or the `shutdown` console command.

Speech is submitted after roughly 0.8 seconds of silence. Unrestricted Fabric mode keeps listening during work/TTS for stop-only interruption. This uses the existing transcription service, not Realtime. Bounded mode retains turn-taking: its microphone pauses during work/replies, so use F9 during that pause. There is no general wake-word filter; ordinary speech captured while idle may be interpreted as a new command. Use headphones and stop listening when talking to someone else.

Death, leaving the world, a bridge disconnect, or a missing heartbeat disarms both modes. In bounded mode, GUI/focus/manual movement also disarm. The browser can keep its microphone prepared while disarmed, but recording/uploading is paused until F8 re-arms. A full disconnect may require clicking Start hands-free again.

## Commands available now

| Say | What it can do |
| --- | --- |
| “Walk forward for two seconds” / “Walk forward until I say stop” | Relative movement for the requested duration; unrestricted mode permits continuing walks. Bounded mode caps walks at ten seconds. |
| “Turn right 90 degrees” / “Look up 20 degrees” | Change view relative to the current direction. |
| “Jump” | A short jump from solid ground. |
| “Mine the block I'm looking at” | Mine one visible block within normal reach. Aim at it first. |
| “Select my diamond pickaxe” | Select that item from any player inventory slot. |
| “Eat some food” | Select inventory food and eat when hungry. |
| “Get a full set of diamond armor and equip it” | Resolve missing prerequisites, gather, smelt, craft and equip; persist progress on interruption or a blocker. |
| “Get eight oak planks” | Gather missing logs and craft toward eight total planks. |
| “Search for an underground base from here at this height, heading east” | Scan and strip-mine parallel branches; stop at suspected structures, blockers or your stop command. |
| “Show my base-search progress” / “Resume my base search” | Read saved coverage, or explicitly resume from its saved cell in the original world/dimension. |
| “Craft an iron pickaxe” / “Smelt three raw iron” | Use available ingredients and normal crafting/furnace menus. Acquisition goals can also gather prerequisites. |
| “Put ten cobblestone in that chest” | Transfer inventory items into a reachable supported container; specify its location if ambiguous. |
| “Place a crafting table at x 5, y 64, z 10” | Place an owned block against reachable support. |
| “Use the item I'm holding” | An ordinary use interaction; it may place a held block or open a GUI. |
| “Attack the entity I'm looking at” | One normal in-reach attack; not automated combat. |
| “Move to x 100, y 64, z 200” | Ground pathfinding with one-block steps. Unrestricted mode has no artificial distance/deadline; bounded mode limits it to 64 blocks. |
| “Follow Steve” | Unrestricted: follow until stopped/replaced, waiting if the player is unloaded. Bounded: up to 60 seconds, within 64 blocks, stopping if lost/blocked. |
| “Stop” / “Stop following” | Cancel the task and automated input. Unrestricted hands-free accepts this during work/replies; F9 works locally. |
| “What am I looking at?” / “What's in my inventory?” | Read state and answer without starting an autonomous task. |

“Follow me” is not meaningful here: **you are the controlled player**. Name someone else. Use the old Mineflayer mode if you want a separate companion to follow your own player.

Ground pathfinding is not parkour, flight, bridging or arbitrary-terrain navigation. Complex blueprint construction, trading and autonomous hunting remain unsupported. Mining, station placement and completed transfers change the world and are not undone by stopping. Server protections still apply. Menus opened by an inventory skill are controlled by that skill; on cancellation a partly filled crafting grid may remain open for you to recover its contents.

## Completing a sequence from one spoken request

The Fabric planner now permits the necessary sequence of supported actions to finish your request, instead of preferring a single short action. For example:

- **“Mine three nearby stone blocks.”** It can inspect, select an appropriate inventory tool, approach the blocks, and make several mining calls, tracking confirmed removals toward three.
- **“Turn right 90 degrees, then walk forward for two seconds.”** It can perform both actions in order without a second spoken command.

It is instructed to stop when the requested outcome is complete, avoid counting failures as progress, and explain any unfinished part if blocked. Necessary inspection, aiming, inventory selection and repositioning do not each require separate confirmation. Questions remain read-only; unrelated excavation and autonomous survival tasks are not authorized.

The updated mining skill can approach and excavate access to the requested target. The actual block-breaking interaction still requires visibility, reach and an appropriate harvest tool. Ordinary coordinate navigation does not excavate. Acquisition goals include necessary mining and station placement, not unrelated destruction.

The existing `.env` setting `MAX_TOOL_ROUNDS` caps bounded mode's action/decision rounds (default 6, supported range 1–12). It is ignored for unrestricted Fabric tasks. Longer sequences can require more API calls and take longer than a single action. Use spoken stop in unrestricted hands-free or F9 for an immediate local interruption.

Unlike the earlier backend-only sequencing change, continuous control needs the updated JAR. Follow the reinstall/restart steps at the top of this guide. Your model selections and API key are unchanged.

The continuation design follows the [official OpenAI multi-step tool-calling flow](https://developers.openai.com/api/docs/guides/function-calling). Regression tests use scripted model responses to verify sequencing, result forwarding, round limits, and cancellation. They do not prove how your live model will interpret every spoken task; test the two examples above in a safe area first.

## Connection checks and troubleshooting

- **Nothing happens on F8:** run `/astra status`. Confirm the backend is running, the panel says Minecraft connected, menus are closed, and the window has focus. Check Minecraft Options → Controls for conflicting or rebound Astra F8/F9 keys.
- **Unknown `/astra` command:** the mod did not load. Check that this launch is Fabric **1.21.11**, Fabric API is installed, and the correct instance contains `astra-voice.jar`.
- **Missing token / disconnected:** run setup for that exact Minecraft instance, then restart Minecraft or use `/astra connect` to reload pairing configuration. Wait up to five seconds for reconnection. Never paste the pairing token or your OpenAI key into chat.
- **Port already in use:** stop the older backend before starting another. The bridge uses `127.0.0.1:8765`; the microphone panel uses `127.0.0.1:3001`. These are local application ports, not your Minecraft server's port. Do not port-forward them. To change them, set `FABRIC_BRIDGE_PORT` / `BROWSER_VOICE_PORT` in `.env`, rerun setup, and restart both components.
- **It disarms when I switch to the browser:** expected in bounded mode only. Check `.env` and `/astra status` for unrestricted mode, and reinstall/restart the new JAR if the backend requests it. Minecraft's own pause menu may still pause game execution.
- **Microphone works but the AI request fails:** check the displayed error stage and `logs\conversations.log` / `logs\agent.log`. Verify API billing and endpoint-compatible model IDs. A model name shown in a coding app does not establish that it is a valid model for the bot's API endpoint. Do not share API keys when asking for help.
- **Reply failed after movement/mining:** the action may already have completed. Read the transcript/reply and inspect Minecraft before repeating a command.
- **It cannot go around a tree or climb stairs:** reinstall the gameplay JAR; coordinate navigation now has local ground A*. Relative “walk forward” is still direct input. Gaps, liquids, inaccessible terrain and server restrictions can still block a route; inspect the reported reason.
- **Other people cannot hear the AI:** expected. This mode speaks through your browser only, not Minecraft's voice channel.

Starting the panel, silent speech detection, snapshots, deterministic input ticks, F8, and F9 do not themselves make OpenAI calls. Submitted speech uses transcription, AI planning (including tool continuations), and speech synthesis API credits. Fabric mode has no periodic autonomous AI calls. Audio is sent to OpenAI for submitted turns; the backend may retain transcripts in the existing memory system. The local pairing token is separate from your OpenAI key.

## Build and verification

Compiled mod: `fabric-mod\build\libs\astra-voice-1.0.0.jar` (use this file, not `-sources.jar`). Mod source and build instructions are in `fabric-mod`.

Backend regression tests: `npm.cmd test`. They use local sockets and mocked AI; they do not spend API credits or log into Minecraft. Java validation tests and the remapped build verify the target game API at compile time. These checks cannot verify your launcher's mod loading, microphone hardware, API account access, server acceptance, or in-game timing. The first-session steps above are the live acceptance test; that test has not been performed automatically.

Initial release verified on 2026-09-05: **83 backend tests and 19 Java tests passed**, with a successful remapped JAR build. `node scripts/verify-fabric-setup.mjs` also passed installation/pairing/backup/preservation checks against a temporary Minecraft instance. Your real Minecraft installation was not modified during verification.

The subsequent action-sequencing policy update passes **88 backend tests**, including five new mocked policy/sequencing/result-forwarding/budget/cancellation regressions. That update leaves the Java mod and existing configuration unchanged; no live model or Minecraft test was run for it.

Continuous control passes **109 backend tests** and **25 Java tests**, including unlimited rounds, stop during a pending planner call, running/queued action cancellation, authenticated concurrent/queued stop speech, input ownership, GUI pause/resume, and physical-key restoration. The installer smoke test passes against temporary folders with the new JAR. These are automated tests, not live microphone/game validation; the real Minecraft installation was not modified by the build or tests.

The Mindcraft-inspired gameplay update passes **127 backend tests and 34 Java tests**, with a successful remapped JAR build and temporary-instance installer smoke test. This includes simulated empty-inventory diamond armor acquisition, recipe yields, prerequisites, batching, inventory verification, capability gating, profile permissions, pause/resume, scheduler cancellation, ground routing and equipment-slot contracts. Live Minecraft inventory/menu timing and terrain traversal remain unverified. No real Minecraft installation or OpenAI API was used during verification.

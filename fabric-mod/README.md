# Astra Voice Controller — Fabric 1.21.11

This is a **client-only mod controlling the player you are logged in as**, not a second Mineflayer account. Minecraft Java **1.21.11 exactly**, Java 21, Fabric Loader 0.18.4 or newer, and the **1.21.11 Fabric API** are required. The server does not need this mod or Simple Voice Chat. Respect the server's rules about automation.

The OpenAI planner, microphone capture and speaker playback stay in the local project/browser. This mod does not contain an API key. After running the updated project installer, it launches the Node backend automatically in the background when Minecraft starts. Its `/astra voice` command opens the local microphone page in your browser. A browser tab must stay open for speech; this is not in-game proximity audio and other players cannot hear browser replies.

## Install and play

1. Build/use `build/libs/astra-voice-1.0.0.jar` (not the `-sources` jar).
2. Use the project installer to copy the jar and local pairing configuration into your Minecraft instance. For a custom launcher, its instance folder may differ from the default `.minecraft` folder. Put the 1.21.11 Fabric API jar in that instance's `mods` folder too.
3. Launch Minecraft's Fabric **1.21.11** profile and join your world/server normally. The updated mod/config starts the backend without opening a command window. Older configs, or an explicit `backend.autoStart: false`, still require the project launcher.
4. Run `/astra voice`. Click **Start hands-free** in the local browser panel, allow microphone access, return to Minecraft, close all menus, and press **F8** to arm.
5. Speak a short command and pause: “walk forward for two seconds”, “turn right 90 degrees”, “jump”, “mine the block I am looking at”, or “follow OtherPlayer”.
6. Say **“stop”** to interrupt through the browser microphone, or use **F9** for an immediate local stop. **F8** toggles arming. Spoken interruption needs the browser microphone/backend/transcription connection to work; F9 does not need OpenAI.

The mod starts **disarmed** and never resumes movement automatically after reconnecting. Use headphones to avoid speaker echo. The mod controls your own player, so “follow me” cannot follow a separate copy of yourself: give another player's username.

## Unrestricted task mode

The project's `.env` selects `FABRIC_UNRESTRICTED=true` unless you explicitly configure it otherwise. The updated backend negotiates this with the updated mod over the authenticated local bridge; `/astra status` shows `UNRESTRICTED` when active. A newly built backend cannot enable this behavior in an old installed jar: **close Minecraft, stop any manually started backend, run the project’s `Setup Fabric Voice.cmd` again to install the rebuilt jar, then relaunch Minecraft**. Only start the backend manually if automatic startup is disabled. For a custom launcher, install into its actual instance directory as before. No pairing-token change is required.

In unrestricted mode, ordinary tasks have no default controller deadline. Following continues until stopped/replaced and waits for an unloaded player to become available again. A walk explicitly requested to continue until stopped uses `duration_ms: 0`; a requested two-second walk still finishes after two seconds. Manual controls and game focus loss no longer disarm the mod. Opening a menu temporarily releases synthetic inputs and defers game actions, then resumes them when the menu closes.

The controller also removes its 64-block navigation limit, obstacle/fluid/drop veto and stuck timer in this mode. Coordinate navigation now uses local ground A*, while relative walks remain direct inputs. This is not flight, bridging or parkour, and dangerous or unloaded terrain can still cause failure. The backend's ongoing planning can spend API credits until you stop it. Finite requested quantities/durations still mean what you asked for; completing three requested blocks does not authorize mining everything forever.

Authentication, valid world/control sessions, finite message/queue memory, Minecraft reach/visibility, server/profile permissions, and input cleanup still apply. Death/spectator mode, world exit, and a lost backend heartbeat stop/disarm because there is no valid controllable player or connection. F8, F9, `/astra stop`, and backend cancellation remain explicit user stops. No setting can guarantee that a server, network, API, or Minecraft will never stop working.

Set `FABRIC_UNRESTRICTED=false` to restore bounded mode. In that mode, manual movement/interaction, turning the mouse during an action, opening a menu, and losing game focus disarm; walking has a 10-second cap, following a 60-second cap, and direct navigation a 64-block cap with conservative ground checks.

Commands: `/astra status`, `/astra voice`, `/astra connect` (reload pairing config and retry), `/astra stop`.

## Implemented actions and boundaries

| Action | Scope |
| --- | --- |
| walk / strafe / turn / jump | Normal player controls; requested durations remain meaningful; unrestricted walks can continue until stopped. Rotation uses relative degrees: positive yaw turns right, positive pitch looks down. |
| use / attack | Normal main-hand interaction or one attack at the current crosshair target. No arbitrary server commands. |
| mine target / mine block | Normal breaking speed, loaded visible block within normal reach. Stops if the target disappears or becomes unreachable. |
| move to / move near | Local ground A* with one-block steps; mining skills can request excavation. Not flight, bridging or parkour. |
| follow player | Acknowledges starting promptly. Unrestricted mode follows/waits for a loaded target until stopped or replaced; bounded mode has safe-ground, range, lost-target, and 60-second limits. |
| find block | Bounded loaded-block scan, radius up to 16. |
| equip item / eat food | Full 36-slot inventory selection, armor/off-hand equipment, and inventory food. |
| craft / smelt | Normal crafting/furnace menu clicks, observed output verification, optional placement of owned stations. |
| place / pickup / containers | Reachable block placement, dropped-item pickup, storage inspection and exact-quantity transfers. |
| say / look at / stop | Plain Minecraft text, local camera rotation, and cancellation. |

The updated mod advertises `gameplay-skills-v1`. The backend adds recursive, persistent item goals and resource search on top of these primitives; see [Mindcraft integration notes](../docs/mindcraft-integration.md). Blueprint construction, flight, teleportation, villager trading and automated hunting/combat are not implemented. It does not bypass reach, permissions or server-side anti-cheat. Inventory skills own their opened menus; stopping may leave a partly filled crafting grid open for human recovery.

The base-search update additionally advertises `base-search-v1`: `scan_search_area` returns a complete air-inclusive loaded cube (radius 1–6), and `base_search_step` excavates only one adjacent same-height head/feet pair, then moves into it. Every mining/movement tick rechecks structure clues, natural-terrain eligibility, floor support, fluids and corridor position. The backend supplies the persistent pattern and evidence detector; these raw primitives are not exposed as planner tools. See [the base-search guide](../docs/base-search.md). Rebuild/reinstall this JAR; no server-side mod is needed.

## Local pairing and security

`config/astra-voice.json` contains `bridgePort`, `voicePort`, and a shared random 64-hex-character `token` matching the project backend. The installer also writes `backend.autoStart`, `backend.projectDirectory` and `backend.nodeExecutable`. These absolute local paths allow direct Node startup without a shell. See `astra-voice.example.json` (automatic startup is deliberately disabled in the placeholder example; the installer enables it for real paths). Keep this token private. There is no remote host field: WebSocket connections are only to `ws://127.0.0.1:<bridgePort>/astra`, authenticated by an Authorization header. The microphone page is `http://127.0.0.1:<voicePort>/`.

The startup worker does not block Minecraft's tick thread. It reuses a compatible authenticated backend already running; otherwise it owns the newly started Node process. Closing Minecraft closes that child's stdin ownership pipe so the backend shuts down, including when Minecraft crashes. Only the owned child may be terminated after the shutdown grace period; independently started processes are never killed. Startup output is appended to the project's `logs/fabric-backend.log`. F8/F9, microphone permission and session/arming checks are unchanged. Automatic startup does not install a Windows service or copy the OpenAI key into Minecraft. See [automatic-start usage and troubleshooting](../docs/fabric-voice.md#automatic-backend-startup).

Protocol v2 ties every action to both the current world session and current arming epoch. Old replies cannot move a newly joined or newly armed player. Inputs owned by the mod are released on cancellation while genuinely held physical keys are preserved. The queue and message sizes are bounded; a missing backend heartbeat for three seconds disconnects and disarms.

## Build and test

From this folder with a **Java 21 JDK** selected in `JAVA_HOME`:

```powershell
.\gradlew.bat build
```

The reproducible pins are Minecraft 1.21.11, Fabric Loom 1.14.10, Fabric Loader 0.18.4, Fabric API 0.141.6+1.21.11 and Gradle 9.2.1, using Mojang's official mappings. Loom creates the intermediary-remapped installable jar at `build/libs/astra-voice-1.0.0.jar`.

The Java unit tests exercise action gating, stale world/epoch rejection, ground routes/steps/excavation, equipment-slot contracts, numeric bounds, unrestricted policy, input ownership, pairing and a local WebSocket handshake. They do not launch Minecraft or spend OpenAI credits. Actual movement, inventory transactions, menu pause/resume, voice interruption and microphone behavior still need a live check after installation.

If this Windows JDK fails to start Gradle with `Unable to establish loopback connection` and an `UnixDomainSockets` stack, the helper `build-mod.cmd` uses a process-local nonexistent Unix-socket directory to make Java fall back to TCP. It does not change Windows security policy or globally install Java.

Official references: [Fabric for Minecraft 1.21.11](https://fabricmc.net/2025/12/05/12111.html), [Fabric API releases](https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/), [Fabric installation](https://fabricmc.net/use/installer/).

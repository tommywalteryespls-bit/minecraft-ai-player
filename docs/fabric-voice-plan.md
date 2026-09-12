# Fabric voice-control implementation plan

Target: Minecraft Java 1.21.11, client-side Fabric. Control the real logged-in player by explicit spoken instructions using the existing browser microphone, OpenAI transcription/planner/TTS, and memory pipeline. Do not create another Minecraft login, change server rules, or expose privileged commands.

1. Implement a Fabric mod with bounded input-driven actions, local enable/panic keys, main-thread game access, world snapshots, and visible status.
2. Replace the Fabric placeholder with a loopback-only authenticated WebSocket adapter. Validate all packets and session/control epochs, restrict advertised actions, cancel stale requests, and partition memory by world.
3. Extend planner tools with explicit short client controls; preserve Mineflayer behavior. Force Fabric command-only operation, disable autonomous/reflex behavior, ignore other players' chat, and bind voice identity to the controlled player's username.
4. Provide a setup script that copies only this mod and its local pairing configuration, backing up existing owned files. Provide a double-click backend launcher; no need to type PowerShell commands for normal use.
5. Build the remapped mod jar and run protocol, cancellation, safety, command-routing, and regression tests with mocked AI. Document any limits; do not claim a live microphone/game test without actually performing one.

Initial scope: timed relative movement, turn/look, jump, stop, basic interaction/attack, reachable-block mining, hotbar selection/food, bounded local movement, and following a named visible player. Complex crafting/building/container automation is not implied by this release. Unsupported commands must fail honestly. The user always joins a world manually and must explicitly enable control for each session. F9 is the immediate local stop; voice stop includes transcription latency.

## Executed — 2026-09-05

All five implementation steps above are complete for this bounded first release. The Minecraft 1.21.11 intermediary-remapped JAR is built, and the setup/start launchers and [playing guide](fabric-voice.md) are included. Review fixes cover quick F9 taps, stale commands, waterlogged-block completion, single-use rather than repeated right-click input, controller-specific voice configuration, and explicit-command-only AI instructions.

Verification: 83 TypeScript/backend/browser/protocol tests and 19 Java tests pass. The installer smoke test copied the compiled JAR into a temporary instance, verified pairing reuse, retained unrelated files/settings, checked backups, and refused malformed settings. No real Minecraft installation was changed, and no paid AI calls or live microphone/game acceptance test was performed. Installation into the user's selected launcher instance and the safe-world acceptance steps remain operator actions.

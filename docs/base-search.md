# Dedicated underground base search

This Fabric 1.21.11 update adds a local search routine. It searches for **suspected structures**, not guaranteed player-owned bases. It never opens containers, enters a detected structure to investigate, places blocks or selects an alternate excavating route around a blocker.

## Install and try

1. Close Minecraft and stop the old backend.
2. Double-click `Setup Fabric Voice.cmd` in this project. This copies the rebuilt JAR and preserves pairing. For a custom launcher instance, use the exact game-directory command in [the Fabric guide](fabric-voice.md).
3. Run `Start Fabric Voice.cmd`, launch **Minecraft Java Edition with Fabric 1.21.11**, and join a backed-up test world or a server where your automation is allowed.
4. Open `/astra voice`, reload the panel, start hands-free, return to Minecraft and press **F8**.
5. Stand on full solid ground at the mining height where you want to start, with a usable pickaxe in your inventory. Start away from your own crafting stations, torches and structures, since the routine cannot determine ownership.
6. Try a short test first: **“Search for an underground base from here, heading east, with two eight-block branches spaced four blocks apart. Stop when you find signs of a structure.”**

For a continuing search:

> “Search for an underground base from here at my current height. Strip-mine east in 32-block parallel branches spaced four blocks apart. Continue until you find signs of a structure or I say stop. Don't open containers or damage a suspected structure.”

Say **“Stop”** or use **F9**. Spoken stop needs successful speech transcription; F9 is the immediate local stop. Stopping is not undo: already removed terrain stays removed.

When idle or stopped, ask **“Show my base-search progress.”** It can report the saved goal ID, last cell, next cell, dimension, branch settings, state and evidence. To continue, return to the saved cell and original dimension, re-arm if necessary, and ask **“Resume my base search.”** If multiple searches exist, specify the goal ID. The routine also accepts its saved adjacent interrupted destination after verifying it was reached. It does not automatically navigate back or restart on login.

## What it does

- Starts at the current feet block and height unless explicitly configured otherwise. For another origin or height, move there first; it will not silently dig a descent or travel route.
- Mines one-block-wide, two-block-high parallel tunnels, joined into a serpentine path by short connecting tunnels. It reverses heading on alternating branches and extends to the original heading's right.
- Scans the complete loaded 9×9×9 block cube around the current cell before each step. Air is included; the limited “useful blocks” snapshot is not used for this decision.
- Executes one adjacent step at a time. The Fabric primitive can break only that step's head and feet cells, using ordinary tools and mining speed. It rechecks nearby structure clues, fluids, floor support and player position during mining/movement.
- Saves a compact confirmed path prefix plus any in-flight destination in the existing world-scoped goal memory. A success acknowledgement alone does not advance coverage: observed player position must match.
- Pauses on clustered evidence or a native construction guard, reports observations and coordinates, and asks before further action. It cannot itself confirm ownership or investigate the interior.

`MEMORY_ENABLED=true` is required; the routine refuses to start without persistent coverage. It reuses existing tools but does not craft replacements, bridge gaps, handle arbitrary elevations, automatically eat or recover from death. Tool failure, a gap, fluids, missing chunks, world changes or server protection can block the route. Resume after addressing the problem, or choose a new search origin.

## Defaults and planner tools

`search_for_base` accepts these nullable parameters (null chooses the default):

| Parameter | Default | Meaning |
| --- | --- | --- |
| `origin` | Current feet block | Integer x/y/z starting cell; must be where you stand. |
| `height` | Origin/current Y | Feet height; must agree with an explicitly supplied origin. |
| `direction` | Nearest cardinal to your view | `north`, `east`, `south`, `west`; first branch heading. |
| `branch_length` | 32 | Forward steps per branch, 1–256. |
| `branch_spacing` | 4 | Centerline spacing, 2–32; four leaves three blocks between adjacent tunnels. |
| `max_branches` | null | No branch-count cap. A supplied count, 1–10000, ends after that many branches. |

These numeric bounds validate the pattern; they are not a newly imposed whole-task timer. Existing unrestricted Fabric mode has no implicit action/task deadline. Bounded mode retains its configured deadlines and can interrupt a long search.

`inspect_base_search` reads saved status (`id: null` lists searches); `resume_base_search` resumes a specified ID only upon a new user request. The raw scan/step primitives are not model tools. They require the connected mod's `base-search-v1` capability. Old JARs do not receive these commands.

The planner uses strict, validated tool schemas following the OpenAI Docs skill and the [official function-calling guidance](https://developers.openai.com/api/docs/guides/function-calling). When a search tool returns, the planner is forced to produce a report, not bypass the stop with generic mining or movement—even for an “until I say stop” command. Your API key, models, voice setup and general unrestricted setting are unchanged.

## Evidence and limitations

Nearby combinations of storage, crafting/workstations, beds/doors, lighting and construction materials raise suspicion. A lone torch or chest does not prove a base. The game-side guard is more conservative: even a single constructed/unknown block close to the planned excavation stops that step before modification. This can stop at mineshafts, generated structures, your own supplies or harmless unfamiliar blocks.

No visible block-state data identifies who placed ordinary stone, dirt or other natural terrain. A player base made only from those materials may go undetected and can be damaged. Plain air corridors are not positive evidence because the search creates corridors itself. No claim of perfect identification or zero damage is possible. Use a test world first.

The routine reads only block state loaded in the client. It does not use world seeds, external maps, container contents or a hidden-base service. Server-hidden blocks and unloaded areas cannot be reliably searched. Saved coverage describes the traversed search route, not every possible nearby location, and does not guarantee finding a base.

The repeated scan/mine/move loop does not call OpenAI per block. Voice transcription, planner requests/results and spoken replies use your configured API services; speech captured for busy-time stop detection can still use credits. While the routine is busy, the existing voice interruption path is stop-only. Stop first to ask other questions or inspect saved progress.

## Verification

Automated verification for this update: **155 backend tests and 40 Java tests passed**, with a successful remapped Fabric JAR build. Tests cover route geometry, evidence false positives, incomplete scans, cancelled/resumed coverage, late replies, world/dimension isolation, invalid saved cursors, profile permissions and preventing planner fallback mining. The installer smoke test uses temporary instance folders only.

No live Minecraft session or paid OpenAI call was used to validate the new routine. Actual server acceptance, mining timing, menu/client behavior and speech recognition still require an in-game acceptance test. For that test, first verify the short finite example, then stop/resume mid-branch, and finally place a chest plus crafting table a few blocks ahead and confirm it stops without touching them.

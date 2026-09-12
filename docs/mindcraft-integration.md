# Mindcraft-inspired gameplay integration

## Source studied

Reference: [Mindcraft develop/src](https://github.com/mindcraft-bots/mindcraft/tree/5f3acc87b479864124173de444f31fa5538f94a6/src), pinned to commit `5f3acc87b479864124173de444f31fa5538f94a6`.
Mindcraft is MIT-licensed; attribution and the full notice are in `THIRD_PARTY_NOTICES.md`, also bundled in the new Fabric JAR.

Studied `agent/npc/item_goal.js`, `agent/npc/controller.js`, `agent/action_manager.js`, `agent/self_prompter.js`, the action-command registry, and the crafting, smelting, navigation, mining and pickup sections of `agent/library/skills.js`.

Mindcraft calls Mineflayer APIs directly. This project now adapts its prerequisite-solving and inventory-progress approach to the existing Fabric voice-control architecture. It does **not** embed the upstream agent or claim complete Mindcraft parity. Existing Mineflayer mode, account settings, API models and voice transport are unchanged.

## Implemented in this update

| Capability | Implementation |
| --- | --- |
| Item acquisition goals | `acquire_item` resolves missing resources, tools, crafting tables and furnaces recursively, using vanilla 1.21.11 recipes. Counts actual inventory holdings. |
| Full armor sets | `diamond_armor`, `iron_armor`, `golden_armor`, `leather_armor` expand to four pieces; `equip=true` equips and verifies worn armor. Leather still needs an available supported ingredient source or leather already in inventory; hunting is not implemented. |
| Saved progress | World-scoped goals record running, paused, blocked or completed state. `list_goals` and `resume_item_goal` support explicit continuation using fresh inventory. Memory must be enabled for persistence across backend restarts. |
| Navigation | Local ground A* routes around obstacles and handles one-block ascent/descent. A finite search-node budget limits CPU per segment, not task duration. |
| Mining and collection | Approach targets, select an existing harvest-capable tool, dig access for mining requests, pick up drops and verify inventory gains. Resource search explores loaded terrain; ore searches use stair-step descent and expanding branches. |
| Crafting | Normal 2×2/3×3 menu clicks using data-derived recipes; checks real recipe output and observed inventory increase. Can place an owned crafting table. |
| Smelting | Normal furnace menu, coal/charcoal fuel, input batches up to 64, output collection. Can place an owned furnace. Existing furnace input/output is not replaced. |
| Inventory and equipment | Main-inventory/hotbar selection, armor and off-hand equipment, and food selection from all 36 player inventory slots. |
| Containers | Inspect, deposit and withdraw from reachable chests, barrels, shulker boxes and hoppers using ordinary menu clicks. Ender chests use Minecraft's chest menu. |
| Block placement | Place owned block items against reachable supporting blocks; checks the resulting block type. |

Planner tools are gated by the connected mod's advertised abilities. Old JARs do not suddenly receive unsupported goal commands. The new JAR advertises `gameplay-skills-v1`.

## How to try it

1. Close Minecraft and stop the old backend.
2. Run `Setup Fabric Voice.cmd` from the project folder to install the rebuilt JAR. For custom instances, follow the exact-directory instructions in [the Fabric guide](fabric-voice.md).
3. Run `Start Fabric Voice.cmd`, launch Fabric 1.21.11, and join a backed-up test world.
4. Open `/astra voice`, reload the panel, start hands-free, then return to the game and press F8.
5. First test “Get eight oak planks.” Then test “Get a full set of diamond armor and equip it.”
6. Say “Stop” or press F9 to interrupt. Later, say “List my goals” and “Resume my diamond armor goal.” Saved goals never start automatically on login.

For the armor request, the planner should call `acquire_item` with `{"item":"diamond_armor","amount":1,"equip":true}`. It reuses existing supplies and gathers missing prerequisites. A fresh set needs 24 diamonds; tools/stations require additional non-diamond resources. Amounts are target **total holdings**, not additional quantities. Crafting can produce recipe-sized surplus, such as four sticks when three are requested.

The existing unrestricted setting retains no implicit task deadline or planner-round cutoff. Bounded mode retains its configured deadlines, which can interrupt long smelting/acquisition tasks. Stop is not undo: mined blocks, placed stations and completed transfers remain. Cancelling a menu transaction attempts to return its cursor item; a menu with remaining crafting-grid items can stay open for human recovery. Inspect the furnace after interrupted smelting before resuming.

## Limits and verification

This is not guaranteed end-to-end diamond acquisition on every world. Loaded terrain, height, liquids, protections, inaccessible ore, full inventories, broken tools and custom recipes can block it. The controller observes client inventory/menu state; it does not claim an independent server transaction acknowledgement. Live latency and inventory resynchronization require in-game testing.

There is no wallhack service or world-seed lookup: searches use block state already present in the client. A server that hides ores from the client can prevent targeted discovery. The ore-depth/search strategy is a built-in heuristic for ordinary Overworld terrain, not an omniscient resource locator. Automatic tool replacement after breakage, cross-dimension resource routes and automatic furnace recovery after interruption are not implemented.

Not ported: blueprint construction, farming/animal husbandry, autonomous mob hunting/combat routines, villager trading, multi-bot coordination, provider switching, vision agents, and Mindcraft's optional generated-code execution. Existing one-click crosshair attack remains available. Runtime-generated host code is not enabled by this integration.

The OpenAI Docs skill guided capability-gated tools and result-driven continuation using the [official function-calling flow](https://developers.openai.com/api/docs/guides/function-calling). Resource prerequisites and individual local gameplay ticks do not call the model. Voice transcription, planner decisions/recovery and spoken replies still use the configured API services. No paid calls were made during automated verification.

Run `npm.cmd test` for backend regressions, the Gradle `build` task in `fabric-mod` for Java tests and the remapped JAR, and `node scripts/verify-fabric-setup.mjs` for temporary-directory installer verification. Goal tests simulate game outcomes, including empty-inventory diamond armor, recipe yields, existing supplies, batches, failed inventory verification, pause/resume and cancellation. Java tests check ground routes, excavation routing, equipment-slot contracts and authorization. They do not launch Minecraft or prove real menu/server timing.

Verified this update: **127 backend tests, 34 Java tests, remapped JAR build and temporary-instance installer smoke test passed**. The installable JAR includes the new gameplay classes and upstream attribution. The real Minecraft installation was not modified; reinstall and perform the live test above before relying on long goals.

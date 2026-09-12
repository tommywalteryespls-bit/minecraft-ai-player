package dev.astra.voice;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.function.BiConsumer;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/** Runs ordinary client controls, never teleports or sends arbitrary packets/commands. */
final class ActionController {
    private final Minecraft client;
    private final OwnedInputs inputs;
    private final ControlPolicy policy;
    private final BiConsumer<JsonObject, JsonObject> respond;
    private JsonObject pending;
    private String mode = "idle";
    private long deadline;
    private Vec3 target, progressPosition;
    private long progressTime;
    private double radius;
    private String followName;
    private BlockPos mining;
    private MiningTarget miningTarget;
    private Direction miningFace;
    private float expectedYaw, expectedPitch;
    private int startingFood;
    private boolean acknowledged;
    private long pausedAt;
    private final InventoryActions inventory;
    private java.util.List<GroundPathfinder.Cell> route = java.util.List.of();
    private boolean canDig, routeMining;
    private String routeMode;
    private int routeIndex, navigationTicks, pickupCount, pickupRadius;
    private String placedItem;
    private BlockPos searchOrigin, searchTarget;
    private boolean searchMining;

    ActionController(Minecraft client, OwnedInputs inputs, ControlPolicy policy, BiConsumer<JsonObject, JsonObject> respond) {
        this.client = client; this.inputs = inputs; this.policy = policy; this.respond = respond;
        this.inventory = new InventoryActions(client);
    }
    boolean active() { return pending != null; }
    boolean ownsScreen() { return mode.equals("inventory") && inventory.ownsScreen(); }
    boolean mouseOverride() {
        return active() && (Math.abs(Mth.wrapDegrees(client.player.getYRot() - expectedYaw)) > 1.0f
            || Math.abs(client.player.getXRot() - expectedPitch) > 1.0f);
    }
    String actionState() {
        return switch (mode) { case "walk", "move", "pickup", "base_search" -> "MOVING"; case "follow" -> "FOLLOWING"; case "mine" -> "MINING";
            case "eat" -> "EATING"; case "use", "inventory" -> "INTERACTING"; case "place" -> "BUILDING"; default -> "IDLE"; };
    }
    void cancel(String reason) { if (active()) finish(false, reason, null); else release(); }
    void cancel(String requestId, String reason) {
        if (pending != null && (requestId == null || requestId.equals(pending.get("requestId").getAsString()))) cancel(reason);
    }
    private void release() {
        inputs.releaseAll();
        if (mining != null && client.gameMode != null) client.gameMode.stopDestroyBlock();
        if ((mode.equals("use") || mode.equals("eat")) && client.gameMode != null && client.player != null && !inputs.physicallyDown(client.options.keyUse)) client.gameMode.releaseUsingItem(client.player);
        inventory.cancel(); route = java.util.List.of(); routeIndex = 0; routeMining = false;
        searchOrigin = null; searchTarget = null; searchMining = false;
        mining = null; miningTarget = null; mode = "idle"; pausedAt = 0;
    }
    private void finish(boolean success, String reason, JsonObject data) {
        JsonObject previous = pending; boolean wasAcknowledged = acknowledged;
        release(); pending = null; acknowledged = false;
        if (previous != null && !wasAcknowledged) respond.accept(previous, result(previous, success, reason, data));
        if (wasAcknowledged && reason != null && client.player != null) client.player.displayClientMessage(net.minecraft.network.chat.Component.literal("Astra: " + reason), true);
    }
    private JsonObject result(JsonObject request, boolean success, String reason, JsonObject data) {
        JsonObject out = new JsonObject();
        out.addProperty("success", success); out.addProperty("action", request.get("action").getAsString());
        if (reason != null) out.addProperty("reason", reason);
        if (data != null) out.add("data", data);
        if (client.player != null) out.add("finalPosition", WorldSnapshot.position(client.player.position()));
        return out;
    }
    void reject(JsonObject request, String reason) { respond.accept(request, result(request, false, reason, null)); }

    void start(JsonObject request) {
        cancel("Replaced by a new voice action");
        pending = request; acknowledged = false;
        if (policy.unrestricted() && client.screen != null) { mode = "deferred"; return; }
        executePending();
    }
    private void executePending() {
        JsonObject request = pending;
        try {
            JsonObject args = ActionValidation.object(request, "arguments");
            String action = ActionValidation.string(request, "action", "", 64);
            long now = System.nanoTime();
            deadline = policy.deadline(request, now);
            progressPosition = client.player.position(); progressTime = now;
            expectedYaw = client.player.getYRot(); expectedPitch = client.player.getXRot();
            switch (action) {
                case "control_player" -> startControl(args, now);
                case "stop_following" -> finish(true, null, null);
                case "look_at" -> { look(position(ActionValidation.object(args, "target"))); finish(true, null, null); }
                case "say" -> {
                    String message = ActionValidation.string(args, "message", "", 256).strip();
                    if (message.isEmpty() || message.startsWith("/") || message.chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException("Only plain chat text is allowed, never server commands");
                    client.player.connection.sendChat(message); finish(true, null, null);
                }
                case "move_to", "move_near" -> {
                    target = position(ActionValidation.object(args, "position"));
                    if (!policy.unrestricted() && client.player.position().distanceTo(target) > 64) throw new IllegalArgumentException("Ground navigation is limited to 64 blocks");
                    radius = ActionValidation.number(args, "radius", action.equals("move_near") ? 2 : 0.7, 0, 16);
                    radius = Math.max(0.6, radius); mode = "move";
                    canDig = args.has("can_dig") && args.get("can_dig").isJsonPrimitive() && args.get("can_dig").getAsBoolean();
                    route = java.util.List.of(); routeIndex = 0; navigationTicks = 0;
                }
                case "follow_player" -> {
                    canDig = false;
                    followName = ActionValidation.string(args, "username", "", 16);
                    if (!followName.matches("[A-Za-z0-9_]{1,16}")) throw new IllegalArgumentException("A valid other player's Minecraft username is required");
                    if (followName.equalsIgnoreCase(client.player.getName().getString())) throw new IllegalArgumentException("This mod controls your own player; name a different player to follow");
                    Player player = findPlayer(followName);
                    if (!policy.unrestricted() && (player == null || player.distanceTo(client.player) > 64)) throw new IllegalArgumentException("That player is not loaded within 64 blocks");
                    target = player == null ? client.player.position() : player.position(); radius = 2.5; mode = "follow";
                    if (!policy.unrestricted()) deadline = now + 60_000_000_000L;
                    JsonObject data = new JsonObject(); data.addProperty("started", true); data.addProperty("untilStopped", policy.unrestricted());
                    if (!policy.unrestricted()) data.addProperty("maxDurationMs", 60000);
                    data.addProperty("waitingForLoadedPlayer", player == null); data.addProperty("username", followName);
                    respond.accept(request, result(request, true, null, data)); acknowledged = true;
                }
                case "find_block" -> {
                    String block = ActionValidation.string(args, "block", "", 128);
                    int range = (int)ActionValidation.number(args, "radius", 8, 1, 16);
                    BlockPos found = findBlock(block, range, false);
                    if (found == null) throw new IllegalArgumentException("No matching block was found in the bounded loaded area");
                    JsonObject data = WorldSnapshot.block(client, found); data.addProperty("block", data.get("name").getAsString());
                    finish(true, null, data);
                }
                case "scan_search_area" -> scanSearchArea(args);
                case "base_search_step" -> {
                    Vec3 requested = position(ActionValidation.object(args, "position"));
                    searchTarget = new BlockPos(BaseSearchRules.coordinate(requested.x), BaseSearchRules.coordinate(requested.y), BaseSearchRules.coordinate(requested.z));
                    searchOrigin = client.player.blockPosition().immutable();
                    if (!BaseSearchRules.adjacentStep(searchCell(searchOrigin), searchCell(searchTarget))) throw new IllegalArgumentException("Search requires exactly one cardinal adjacent block at the current feet height");
                    mode = "base_search"; target = new Vec3(searchTarget.getX()+0.5, searchTarget.getY(), searchTarget.getZ()+0.5);
                    // This action never invokes ground A*, right-click interactions or general mining routes.
                    // It rechecks the entire corridor before the first mutation and every subsequent tick.
                    advanceSearchStep();
                }
                case "mine_block" -> {
                    BlockPos found;
                    if (args.has("position") && !args.get("position").isJsonNull()) found = BlockPos.containing(position(ActionValidation.object(args, "position")));
                    else found = findBlock(ActionValidation.string(args, "block", "", 128), 5, true);
                    if (found == null) throw new IllegalArgumentException("No matching block is visible within normal reach; move closer first");
                    beginMining(found);
                }
                case "equip_item", "craft_item", "smelt_item", "inspect_container", "deposit_item", "withdraw_item" -> { mode = "inventory"; inventory.start(action, args); }
                case "pickup_items" -> { mode = "pickup"; radius = 0.8; canDig = false; pickupCount = inventoryTotal(); pickupRadius = (int)ActionValidation.number(args, "radius", 8, 1, 16); }
                case "place_block" -> {
                    String item = ActionValidation.string(args, "item", "", 128); inventory.select(item);
                    if (!(client.player.getMainHandItem().getItem() instanceof net.minecraft.world.item.BlockItem blockItem)) throw new IllegalArgumentException("Item is not a placeable block");
                    placedItem = BuiltInRegistries.BLOCK.getKey(blockItem.getBlock()).getPath();
                    BlockPos pos = BlockPos.containing(position(ActionValidation.object(args, "position")));
                    if (!client.level.getBlockState(pos).canBeReplaced()) throw new IllegalArgumentException("Target block is not replaceable");
                    boolean attempted = false;
                    for (Direction face : Direction.values()) {
                        BlockPos support = pos.relative(face.getOpposite());
                        if (args.has("against") && !args.get("against").isJsonNull() && !support.equals(BlockPos.containing(position(ActionValidation.object(args, "against"))))) continue;
                        if (client.level.getBlockState(support).getCollisionShape(client.level, support).isEmpty()) continue;
                        Vec3 point = Vec3.atCenterOf(support).add(face.getStepX()*0.5, face.getStepY()*0.5, face.getStepZ()*0.5);
                        if (client.player.getEyePosition().distanceTo(point) > client.player.blockInteractionRange()) continue;
                        look(point); client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, new BlockHitResult(point, face, support, false)); attempted = true; break;
                    }
                    if (!attempted) throw new IllegalArgumentException("No reachable placement support");
                    target = Vec3.atCenterOf(pos); mode = "place"; progressTime = now;
                }
                case "eat_best_food" -> {
                    if (client.player.getFoodData().getFoodLevel() >= 20) throw new IllegalArgumentException("The hunger bar is already full");
                    int best = -1, nutrition = -1;
                    for (int slot = 0; slot < 36; slot++) {
                        var food = client.player.getInventory().getItem(slot).get(DataComponents.FOOD);
                        if (food != null && food.nutrition() > nutrition) { best = slot; nutrition = food.nutrition(); }
                    }
                    if (best < 0) throw new IllegalArgumentException("No food is available in your inventory");
                    inventory.select(InventoryActions.name(client.player.getInventory().getItem(best))); startingFood = client.player.getFoodData().getFoodLevel();
                    mode = "eat"; if (!policy.unrestricted()) deadline = Math.min(deadline, now + 5_000_000_000L);
                    client.gameMode.useItem(client.player, InteractionHand.MAIN_HAND); inputs.hold(client.options.keyUse);
                }
                default -> throw new IllegalArgumentException("Unsupported Fabric action");
            }
        } catch (RuntimeException error) { finish(false, error.getMessage() == null ? "Invalid action" : error.getMessage(), null); }
    }

    private void startControl(JsonObject args, long now) {
        String command = ActionValidation.string(args, "command", "", 32);
        long duration = policy.duration(args, command);
        if (duration > 0) deadline = Math.min(deadline, now + duration * 1_000_000L);
        switch (command) {
            case "stop" -> finish(true, null, null);
            case "turn" -> {
                double yaw = ActionValidation.number(args, "yaw", 0, -180, 180);
                double pitch = ActionValidation.number(args, "pitch", 0, -90, 90);
                client.player.setYRot(Mth.wrapDegrees(client.player.getYRot() + (float)yaw));
                client.player.setXRot(Mth.clamp(client.player.getXRot() + (float)pitch, -90, 90));
                expectedYaw = client.player.getYRot(); expectedPitch = client.player.getXRot(); finish(true, null, null);
            }
            case "walk" -> {
                String direction = ActionValidation.string(args, "direction", "forward", 16);
                switch (direction) {
                    case "forward" -> inputs.hold(client.options.keyUp);
                    case "backward" -> inputs.hold(client.options.keyDown);
                    case "left" -> inputs.hold(client.options.keyLeft);
                    case "right" -> inputs.hold(client.options.keyRight);
                    default -> throw new IllegalArgumentException("Unknown walking direction");
                }
                double degrees = client.player.getYRot() + switch (direction) { case "backward" -> 180; case "left" -> -90; case "right" -> 90; default -> 0; };
                target = new Vec3(-Math.sin(Math.toRadians(degrees)), 0, Math.cos(Math.toRadians(degrees)));
                mode = "walk";
                if (duration == 0) {
                    JsonObject data = new JsonObject(); data.addProperty("started", true); data.addProperty("untilStopped", true);
                    respond.accept(pending, result(pending, true, null, data)); acknowledged = true;
                }
            }
            case "jump" -> { if (!policy.unrestricted() && !client.player.onGround()) throw new IllegalArgumentException("Jump needs solid ground"); mode = "jump"; inputs.hold(client.options.keyJump); if (!policy.unrestricted()) deadline = Math.min(deadline, now + 500_000_000L); }
            case "use" -> useOnce();
            case "mine_target" -> {
                if (!(client.hitResult instanceof BlockHitResult hit) || hit.getType() != HitResult.Type.BLOCK) throw new IllegalArgumentException("Aim your crosshair at the block first");
                // Mining uses the configured action deadline, not the default walk duration.
                deadline = policy.deadline(pending, now);
                beginMining(hit.getBlockPos());
            }
            case "attack" -> {
                JsonObject data = new JsonObject();
                if (client.hitResult instanceof EntityHitResult hit && hit.getLocation().distanceTo(client.player.getEyePosition()) <= client.player.entityInteractionRange()) {
                    client.gameMode.attack(client.player, hit.getEntity()); data.addProperty("attackAttempted", true); data.addProperty("target", hit.getEntity().getName().getString());
                } else data.addProperty("attackAttempted", false);
                data.addProperty("swungHand", true); client.player.swing(InteractionHand.MAIN_HAND); finish(true, null, data);
            }
            default -> throw new IllegalArgumentException("Unknown player control command");
        }
    }

    private void useOnce() {
        mode = "use";
        InteractionResult result = InteractionResult.PASS;
        if (client.hitResult instanceof EntityHitResult hit && hit.getLocation().distanceTo(client.player.getEyePosition()) <= client.player.entityInteractionRange()) {
            result = client.gameMode.interactAt(client.player, hit.getEntity(), hit, InteractionHand.MAIN_HAND);
            if (!result.consumesAction() && result != InteractionResult.FAIL) result = client.gameMode.interact(client.player, hit.getEntity(), InteractionHand.MAIN_HAND);
        } else if (client.hitResult instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK
            && hit.getLocation().distanceTo(client.player.getEyePosition()) <= client.player.blockInteractionRange()) {
            result = client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
        }
        if (!result.consumesAction() && result != InteractionResult.FAIL) result = client.gameMode.useItem(client.player, InteractionHand.MAIN_HAND);
        if (result.consumesAction()) client.player.swing(InteractionHand.MAIN_HAND);
        JsonObject data = new JsonObject(); data.addProperty("attempted", true); data.addProperty("acceptedByClient", result.consumesAction());
        // One right-click attempt, not a held key that could place multiple blocks.
        finish(result != InteractionResult.FAIL, result == InteractionResult.FAIL ? "Minecraft refused this interaction" : null, data);
    }

    void tick() {
        if (!active()) return;
        long now = System.nanoTime();
        if (policy.unrestricted() && client.screen != null && !ownsScreen()) {
            if (pausedAt == 0) pausedAt = now;
            inputs.suspend(); return;
        }
        if (pausedAt != 0) {
            if (deadline != Long.MAX_VALUE) deadline += now - pausedAt;
            pausedAt = 0; inputs.resume();
        }
        if (mode.equals("deferred")) { executePending(); return; }
        if (now >= deadline) {
            boolean completed = mode.equals("walk") || mode.equals("jump") || mode.equals("use");
            finish(completed, completed ? null : "Action time limit reached; controls released", null); return;
        }
        // Physical key-up events and window changes can clear Minecraft's KeyMapping state.
        // Reapply desired inputs each active tick, but never while a GUI is open above.
        if (policy.unrestricted()) inputs.resume();
        if (mode.equals("inventory")) {
            try { JsonObject result = inventory.tick(); if (result != null) finish(true, null, result); }
            catch (RuntimeException error) { finish(false, error.getMessage(), null); }
            return;
        }
        if (mode.equals("place")) {
            if (BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(BlockPos.containing(target)).getBlock()).getPath().equals(placedItem)) { finish(true, null, null); return; }
            if (now - progressTime > 5_000_000_000L) finish(false, "Minecraft did not confirm block placement", null);
            return;
        }
        if (mode.equals("eat")) {
            if (client.player.getFoodData().getFoodLevel() > startingFood) finish(true, null, null);
            else inputs.hold(client.options.keyUse);
            return;
        }
        if (mode.equals("mine")) {
            if (searchMining && !guardSearchStep()) return;
            if (miningTarget.removedOrReplaced(blockId(mining))) { miningDone(); return; }
            BlockHitResult hit = reachableHit(mining);
            if (hit == null) { finish(false, "The block is no longer visible within reach", null); return; }
            // Manual mouse input no longer cancels unrestricted tasks. Maintain the requested
            // target so held attack cannot silently mine a different block after the user turns.
            if (policy.unrestricted()) look(hit.getLocation());
            // Minecraft's normal held-attack tick advances the break exactly once per tick.
            // Calling continueDestroyBlock here as well would double-count progress.
            inputs.hold(client.options.keyAttack); return;
        }
        if (mode.equals("base_search")) { advanceSearchStep(); return; }
        if (mode.equals("walk")) {
            if (!policy.unrestricted() && !safeStep(target)) finish(false, "Stopped before an obstacle, fluid, or unsupported drop", null);
            return;
        }
        if (mode.equals("pickup")) {
            double nearest = pickupRadius * pickupRadius; net.minecraft.world.entity.item.ItemEntity item = null;
            for (var entity : client.level.entitiesForRendering()) if (entity instanceof net.minecraft.world.entity.item.ItemEntity drop && drop.isAlive() && inventory.hasRoom(drop.getItem()) && drop.distanceToSqr(client.player) < nearest) { nearest = drop.distanceToSqr(client.player); item = drop; }
            if (item == null) { JsonObject data = new JsonObject(); data.addProperty("pickedUp", Math.max(0, inventoryTotal()-pickupCount)); finish(true, null, data); return; }
            target = item.position();
        }
        if (!mode.equals("move") && !mode.equals("follow") && !mode.equals("pickup")) return;
        if (mode.equals("follow")) {
            Player player = findPlayer(followName);
            if (player == null || !player.isAlive() || (!policy.unrestricted() && player.distanceTo(client.player) > 64)) {
                if (policy.unrestricted()) { inputs.release(client.options.keyUp); inputs.release(client.options.keyJump); return; }
                finish(false, "Following stopped: target lost", null); return;
            }
            target = player.position();
        }
        Vec3 delta = target.subtract(client.player.position());
        double horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
        if (horizontal <= radius && Math.abs(delta.y) < 0.8) {
            inputs.release(client.options.keyUp); inputs.release(client.options.keyJump); progressPosition = client.player.position(); progressTime = now;
            if (mode.equals("move")) finish(true, null, null);
            return;
        }
        navigate(now); return;
    }

    private int inventoryTotal() { int result = 0; for (int slot = 0; slot < 36; slot++) result += client.player.getInventory().getItem(slot).getCount(); return result; }

    private static BaseSearchRules.Cell searchCell(BlockPos pos) { return new BaseSearchRules.Cell(pos.getX(), pos.getY(), pos.getZ()); }
    private boolean searchLoaded(BlockPos pos) { return !client.level.isOutsideBuildHeight(pos) && client.level.hasChunkAt(pos); }
    private JsonObject searchBlock(BlockPos pos) {
        JsonObject block = new JsonObject(); String id = blockId(pos);
        block.addProperty("name", id.startsWith("minecraft:") ? id.substring(10) : id);
        block.add("position", WorldSnapshot.position(new Vec3(pos.getX(), pos.getY(), pos.getZ())));
        return block;
    }
    private void scanSearchArea(JsonObject args) {
        int range = BaseSearchRules.radius(ActionValidation.number(args, "radius", 4, 1, 6));
        BlockPos center = client.player.blockPosition(); JsonArray blocks = new JsonArray(); int missing = 0;
        for (var offset : BaseSearchRules.cubeOffsets(range)) {
            BlockPos pos = center.offset(offset.x(), offset.y(), offset.z());
            if (!searchLoaded(pos)) { missing++; continue; }
            // Do not use nearbyUsefulBlocks: air and uninteresting stone are required for coverage/evidence.
            blocks.add(searchBlock(pos));
        }
        JsonObject data = new JsonObject(); data.add("center", WorldSnapshot.position(new Vec3(center.getX(),center.getY(),center.getZ())));
        data.addProperty("radius", range); data.addProperty("complete", missing == 0); data.addProperty("missingCells", missing);
        data.addProperty("expectedCells", (2*range+1)*(2*range+1)*(2*range+1)); data.add("blocks", blocks);
        finish(true, null, data);
    }
    private boolean blockSearch(String reason, BlockPos blocked, boolean suspectedStructure) {
        JsonObject data = new JsonObject(); data.addProperty("suspectedStructure", suspectedStructure);
        if (blocked != null) {
            if (searchLoaded(blocked)) data.add("blockedBlock", searchBlock(blocked));
            else data.add("blockedPosition", WorldSnapshot.position(new Vec3(blocked.getX(),blocked.getY(),blocked.getZ())));
        }
        finish(false, reason, data); return false;
    }
    private boolean guardSearchStep() {
        BlockPos current = client.player.blockPosition();
        if ((!current.equals(searchOrigin) && !current.equals(searchTarget)) || Math.abs(client.player.getY()-searchTarget.getY()) > 0.15)
            return blockSearch("Search stopped because the player left the exact level corridor; no alternate route was attempted", null, false);
        // Complete local knowledge is mandatory. A network-delayed cell is not permission to mine it.
        // The two-block-high target is surrounded by two cells on every side; suspicious construction
        // stops the search even when the block being broken is ordinary stone next to that construction.
        for (var offset : BaseSearchRules.corridorProbe()) {
            BlockPos pos = searchTarget.offset(offset.x(),offset.y(),offset.z());
            if (!searchLoaded(pos)) return blockSearch("Search stopped at unloaded terrain or the world height boundary", pos, false);
            var state = client.level.getBlockState(pos);
            if (state.hasBlockEntity() || BaseSearchRules.structureClue(blockId(pos)))
                return blockSearch("Possible structure nearby; excavation stopped without entering or interacting", pos, true);
        }
        for (BlockPos feet : new BlockPos[]{searchOrigin, searchTarget}) {
            BlockPos floor = feet.below();
            if (!searchLoaded(floor) || !client.level.getFluidState(floor).isEmpty() || hazard(floor)
                || !client.level.getBlockState(floor).isFaceSturdy(client.level, floor, Direction.UP))
                return blockSearch("Search stopped before a fluid, unsafe floor or unsupported drop", floor, false);
            for (BlockPos body : new BlockPos[]{feet, feet.above()}) {
                if (!searchLoaded(body) || !client.level.getFluidState(body).isEmpty() || hazard(body))
                    return blockSearch("Search stopped before fluid or hazardous terrain", body, false);
            }
        }
        for (BlockPos body : new BlockPos[]{searchTarget.above(), searchTarget}) {
            var state = client.level.getBlockState(body);
            if (!state.isAir() && (!BaseSearchRules.naturalTerrain(blockId(body)) || state.hasBlockEntity()))
                return blockSearch("Search will not excavate a block outside the natural-terrain allowlist", body, BaseSearchRules.structureClue(blockId(body)) || state.hasBlockEntity());
            for (Direction face : Direction.values()) {
                BlockPos adjacent = body.relative(face);
                if (!client.level.getFluidState(adjacent).isEmpty() || hazard(adjacent))
                    return blockSearch("Search stopped before opening onto adjacent fluid or hazardous terrain", adjacent, false);
            }
        }
        return true;
    }
    private void advanceSearchStep() {
        if (!guardSearchStep()) return;
        inputs.release(client.options.keyJump); inputs.release(client.options.keyAttack);
        // Only these two coordinates may be broken. A generic pathfinder must never choose another block.
        for (BlockPos obstruction : new BlockPos[]{searchTarget.above(), searchTarget}) {
            if (client.level.getBlockState(obstruction).getCollisionShape(client.level, obstruction).isEmpty()) continue;
            inputs.release(client.options.keyUp);
            searchMining = true;
            try { beginMining(obstruction); }
            catch (RuntimeException error) { finish(false, error.getMessage(), null); }
            return;
        }
        Vec3 delta = target.subtract(client.player.position()); double horizontal = Math.sqrt(delta.x*delta.x+delta.z*delta.z);
        if (client.player.blockPosition().equals(searchTarget) && horizontal <= 0.22 && Math.abs(delta.y) < 0.15) {
            JsonObject data = new JsonObject(); data.addProperty("verified", true);
            data.add("position", WorldSnapshot.position(new Vec3(searchTarget.getX(),searchTarget.getY(),searchTarget.getZ())));
            data.addProperty("suspectedStructure", false); finish(true, null, data); return;
        }
        client.player.setSprinting(false);
        client.player.setYRot((float)Math.toDegrees(Math.atan2(-delta.x,delta.z)));
        expectedYaw = client.player.getYRot(); expectedPitch = client.player.getXRot(); inputs.hold(client.options.keyUp);
    }

    private void navigate(long now) {
        if (routeIndex >= route.size() || ++navigationTicks % 30 == 0) {
            var start = client.player.blockPosition(); var goal = BlockPos.containing(target);
            route = GroundPathfinder.find(new GroundPathfinder.Cell(start.getX(), start.getY(), start.getZ()), new GroundPathfinder.Cell(goal.getX(), goal.getY(), goal.getZ()), radius,
                new GroundPathfinder.Terrain() {
                    public double bodyCost(GroundPathfinder.Cell cell) {
                        BlockPos pos = new BlockPos(cell.x(), cell.y(), cell.z());
                        if (!client.level.hasChunkAt(pos)) return Double.POSITIVE_INFINITY;
                        var state = client.level.getBlockState(pos);
                        if (state.getCollisionShape(client.level, pos).isEmpty()) return 0;
                        return canDig && !state.hasBlockEntity() && state.getDestroySpeed(client.level, pos) >= 0 ? 8 : Double.POSITIVE_INFINITY;
                    }
                    public boolean support(GroundPathfinder.Cell cell) { BlockPos pos = new BlockPos(cell.x(), cell.y(), cell.z()); return client.level.hasChunkAt(pos) && !client.level.getBlockState(pos).getCollisionShape(client.level, pos).isEmpty(); }
                }, 4096);
            routeIndex = 0;
            // A cell-based search may already be inside its goal radius while the
            // player's sub-block position still needs a small final correction.
            if (route.isEmpty() && start.getY() == goal.getY() && Math.abs(start.getX()-goal.getX()) + Math.abs(start.getZ()-goal.getZ()) <= radius) {
                route = java.util.List.of(new GroundPathfinder.Cell(start.getX(), start.getY(), start.getZ()));
            }
            if (route.isEmpty()) { finish(false, "No loaded walkable ground route; excavation may require different coordinates or tools", null); return; }
        }
        var cell = route.get(routeIndex); BlockPos step = new BlockPos(cell.x(), cell.y(), cell.z());
        Vec3 next = new Vec3(cell.x()+0.5, cell.y(), cell.z()+0.5);
        if (route.size() == 1 && step.equals(client.player.blockPosition()) && cell.y() == BlockPos.containing(target).getY()) next = target;
        if (client.player.position().distanceTo(next) < 0.45) { routeIndex++; return; }
        if (canDig) for (BlockPos obstruction : new BlockPos[]{step.above(), step, step.getY() > client.player.blockPosition().getY() ? client.player.blockPosition().above(2) : step}) {
            if (client.level.getBlockState(obstruction).getCollisionShape(client.level, obstruction).isEmpty()) continue;
            inputs.release(client.options.keyUp); inputs.release(client.options.keyJump);
            routeMining = true; routeMode = mode;
            try { beginMining(obstruction); } catch (RuntimeException error) { finish(false, error.getMessage(), null); }
            return;
        }
        Vec3 delta = next.subtract(client.player.position());
        double horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
        if (horizontal < 0.1) { inputs.release(client.options.keyUp); if (delta.y > 0) inputs.hold(client.options.keyJump); return; }
        Vec3 direction = new Vec3(delta.x / horizontal, 0, delta.z / horizontal);
        if (!policy.unrestricted() && !safeStep(direction) && delta.y <= 0) { finish(false, "Route crosses terrain excluded by bounded mode", null); return; }
        client.player.setYRot((float)Math.toDegrees(Math.atan2(-delta.x, delta.z)));
        expectedYaw = client.player.getYRot(); expectedPitch = client.player.getXRot();
        inputs.hold(client.options.keyUp);
        if (delta.y > 0.3 || (policy.unrestricted() && (client.player.horizontalCollision || client.player.isInWater()))) inputs.hold(client.options.keyJump);
        else inputs.release(client.options.keyJump);
        if (client.player.position().distanceTo(progressPosition) > 0.35) { progressPosition = client.player.position(); progressTime = now; }
        else if (!policy.unrestricted() && now - progressTime > 2_500_000_000L) finish(false, "Movement stopped because the player was stuck", null);
    }

    private boolean safeStep(Vec3 direction) {
        Vec3 next = client.player.position().add(direction.scale(0.8));
        BlockPos feet = BlockPos.containing(next);
        if (!client.level.hasChunkAt(feet)) return false;
        if (hazard(feet) || hazard(feet.below())) return false;
        if (!client.level.getFluidState(feet).isEmpty() || !client.level.getFluidState(feet.below()).isEmpty()) return false;
        if (!client.level.getBlockState(feet).getCollisionShape(client.level, feet).isEmpty()
            || !client.level.getBlockState(feet.above()).getCollisionShape(client.level, feet.above()).isEmpty()) return false;
        return !client.level.getBlockState(feet.below()).getCollisionShape(client.level, feet.below()).isEmpty();
    }
    private boolean hazard(BlockPos pos) {
        String name = BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(pos).getBlock()).getPath();
        return switch (name) {
            case "fire", "soul_fire", "magma_block", "cactus", "sweet_berry_bush", "wither_rose", "campfire", "soul_campfire", "powder_snow" -> true;
            default -> false;
        };
    }
    private void beginMining(BlockPos pos) {
        BlockHitResult hit = reachableHit(pos);
        if (hit == null || client.level.getBlockState(pos).isAir()) throw new IllegalArgumentException("Block must be visible within normal reach; move closer first");
        if (client.level.getBlockState(pos).getDestroySpeed(client.level, pos) < 0) throw new IllegalArgumentException("This block cannot be mined");
        var state = client.level.getBlockState(pos); String best = null; float speed = -1;
        for (int slot = 0; slot < 36; slot++) {
            ItemStack stack = client.player.getInventory().getItem(slot);
            if (state.requiresCorrectToolForDrops() && !stack.isCorrectToolForDrops(state)) continue;
            if (stack.getDestroySpeed(state) > speed) { speed = stack.getDestroySpeed(state); best = InventoryActions.name(stack); }
        }
        if (best != null && !best.equals("air")) inventory.select(best);
        if (!client.player.isCreative() && state.requiresCorrectToolForDrops() && !client.player.getMainHandItem().isCorrectToolForDrops(state)) throw new IllegalArgumentException("Missing a tool capable of harvesting this block");
        mining = pos.immutable(); miningTarget = new MiningTarget(blockId(pos)); miningFace = hit.getDirection(); mode = "mine";
        look(hit.getLocation());
        if (!client.gameMode.startDestroyBlock(mining, miningFace)) throw new IllegalArgumentException("Minecraft refused to start breaking this block");
        // Creative/instant breaks can replace the block before the next tick. Do not hold
        // attack into the replacement fluid or the next block beyond the original target.
        if (miningTarget.removedOrReplaced(blockId(mining))) { miningDone(); return; }
        inputs.hold(client.options.keyAttack);
    }
    private void miningDone() {
        if (searchMining) {
            inputs.release(client.options.keyAttack); client.gameMode.stopDestroyBlock(); mining = null; miningTarget = null;
            mode = "base_search"; searchMining = false; return;
        }
        if (!routeMining) { finish(true, null, null); return; }
        inputs.release(client.options.keyAttack); client.gameMode.stopDestroyBlock(); mining = null; miningTarget = null;
        mode = routeMode; routeMining = false; route = java.util.List.of(); routeIndex = 0;
    }
    private String blockId(BlockPos pos) { return BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(pos).getBlock()).toString(); }
    private BlockHitResult reachableHit(BlockPos pos) {
        if (!client.level.hasChunkAt(pos)) return null;
        Vec3 eye = client.player.getEyePosition(), center = Vec3.atCenterOf(pos);
        if (eye.distanceTo(center) > client.player.blockInteractionRange()) return null;
        BlockHitResult hit = client.level.clip(new ClipContext(eye, center, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, client.player));
        return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(pos) ? hit : null;
    }
    private void look(Vec3 point) {
        Vec3 delta = point.subtract(client.player.getEyePosition());
        client.player.setYRot((float)Math.toDegrees(Math.atan2(-delta.x, delta.z)));
        client.player.setXRot((float)-Math.toDegrees(Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z))));
        expectedYaw = client.player.getYRot(); expectedPitch = client.player.getXRot();
    }
    private static Vec3 position(JsonObject point) {
        return new Vec3(ActionValidation.number(point, "x", Double.NaN, -29999984, 29999984),
            ActionValidation.number(point, "y", Double.NaN, -2048, 2048), ActionValidation.number(point, "z", Double.NaN, -29999984, 29999984));
    }
    private Player findPlayer(String name) {
        for (Player player : client.level.players()) if (player.getName().getString().equalsIgnoreCase(name)) return player;
        return null;
    }
    private int findHotbar(String name) {
        if (name.isBlank()) return -1;
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = client.player.getInventory().getItem(slot);
            if (!stack.isEmpty() && matches(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), name)) return slot;
        }
        return -1;
    }
    private BlockPos findBlock(String name, int range, boolean requireReach) {
        if (name.isBlank()) throw new IllegalArgumentException("A block name is required");
        BlockPos origin = client.player.blockPosition(), best = null; double distance = Double.MAX_VALUE;
        for (BlockPos pos : BlockPos.betweenClosed(origin.offset(-range, -range, -range), origin.offset(range, range, range))) {
            if (!client.level.hasChunkAt(pos)) continue;
            double current = client.player.position().distanceToSqr(Vec3.atCenterOf(pos));
            if (current >= distance || current > range * range) continue;
            if (matches(BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(pos).getBlock()).toString(), name)
                && (!requireReach || reachableHit(pos) != null)) { best = pos.immutable(); distance = current; }
        }
        return best;
    }
    private static boolean matches(String id, String requested) { return id.equals(requested) || id.equals("minecraft:" + requested); }
}

package dev.astra.voice;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.Deque;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.inventory.FurnaceMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/** Normal inventory clicks against the current server menu. Never creates items or sends commands. */
final class InventoryActions {
    private record Click(int slot, int button, ClickType type) {}
    private final Minecraft client;
    private final Deque<Click> clicks = new ArrayDeque<>();
    private AbstractContainerMenu owned;
    private JsonObject args;
    private String action, phase, item, output;
    private int amount, initial, cell, cursorHome = -1, ticks, moved, previousCount;
    private long awaitingSince;
    private BlockPos station;
    private boolean table;

    InventoryActions(Minecraft client) { this.client = client; }
    static String name(ItemStack stack) { return BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath(); }
    int count(String name) { int count = 0; for (int i = 0; i < 36; i++) { var stack = client.player.getInventory().getItem(i); if (name(stack).equals(name)) count += stack.getCount(); } return count; }
    boolean ownsScreen() {
        if (owned != null) return client.player.containerMenu == owned;
        return "open".equals(phase) && expectedMenu(client.player.containerMenu);
    }
    private boolean expectedMenu(AbstractContainerMenu menu) {
        if (action == null) return false;
        if (action.equals("craft_item")) return table ? menu instanceof CraftingMenu : menu == client.player.inventoryMenu;
        if (action.equals("smelt_item")) return menu instanceof FurnaceMenu;
        if (action.equals("equip_item")) return menu == client.player.inventoryMenu;
        return menu instanceof net.minecraft.world.inventory.ChestMenu || menu instanceof net.minecraft.world.inventory.HopperMenu || menu instanceof net.minecraft.world.inventory.ShulkerBoxMenu;
    }
    void start(String action, JsonObject args) {
        cancel(); this.action = action; this.args = args;
        item = ActionValidation.string(args, "item", "", 128);
        amount = (int)ActionValidation.number(args, "amount", 1, 1, 2304);
        moved = 0; ticks = 0; cell = 0; table = false; initial = count(item);
        if (!client.player.containerMenu.getCarried().isEmpty()) throw new IllegalArgumentException("Put the item on your cursor away first");
        if (action.equals("equip_item")) {
            owned = client.player.inventoryMenu; phase = "equip";
            equip(); return;
        }
        if (action.equals("craft_item")) {
            var grid = args.getAsJsonArray("grid");
            if (grid == null || grid.isEmpty() || grid.size() > 3) throw new IllegalArgumentException("A vanilla crafting grid is required");
            for (var row : grid) {
                if (!row.isJsonArray() || row.getAsJsonArray().size() > 3) throw new IllegalArgumentException("Invalid crafting grid");
                if (row.getAsJsonArray().size() > 2) table = true;
                for (var ingredient : row.getAsJsonArray()) if (!ingredient.isJsonNull() && (!ingredient.isJsonPrimitive() || !ingredient.getAsJsonPrimitive().isString())) throw new IllegalArgumentException("Invalid recipe ingredient");
            }
            if (grid.size() > 2) table = true;
            output = item; initial = count(output);
            if (!table) { owned = client.player.inventoryMenu; client.setScreen(new InventoryScreen(client.player)); phase = "clear"; return; }
            openStation("crafting_table");
        } else if (action.equals("smelt_item")) {
            item = ActionValidation.string(args, "input", "", 128);
            output = ActionValidation.string(args, "output", "", 128);
            if (output.isEmpty() || amount > 64) throw new IllegalArgumentException("Smelting needs a known output and at most 64 input items per batch");
            initial = count(output); openStation("furnace");
        } else {
            var pos = ActionValidation.object(args, "position");
            station = BlockPos.containing(ActionValidation.number(pos, "x", Double.NaN, -30000000, 30000000), ActionValidation.number(pos, "y", Double.NaN, -2048, 2048), ActionValidation.number(pos, "z", Double.NaN, -30000000, 30000000));
            String block = BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(station).getBlock()).getPath();
            if (!(block.contains("chest") || block.equals("barrel") || block.contains("shulker_box") || block.equals("hopper"))) throw new IllegalArgumentException("Target is not a supported storage container");
            interact(station); phase = "open"; awaitingSince = System.nanoTime();
        }
    }
    void select(String item) {
        if (client.player.containerMenu != client.player.inventoryMenu) throw new IllegalArgumentException("Close the current container before selecting inventory items");
        for (int i = 0; i < 36; i++) if (name(client.player.getInventory().getItem(i)).equals(item) && !client.player.getInventory().getItem(i).isEmpty()) {
            if (i < 9) client.player.getInventory().setSelectedSlot(i);
            else { client.gameMode.handleInventoryMouseClick(client.player.inventoryMenu.containerId, i, 8, ClickType.SWAP, client.player); client.player.getInventory().setSelectedSlot(8); }
            return;
        }
        throw new IllegalArgumentException("Item is not in the player inventory: " + item);
    }
    private void equip() {
        String destination = ActionValidation.string(args, "destination", "hand", 32);
        if (destination.equals("hand")) { select(item); return; }
        int target = switch (destination) { case "head" -> 5; case "torso" -> 6; case "legs" -> 7; case "feet" -> 8; case "off-hand" -> 45; default -> throw new IllegalArgumentException("Unknown equipment slot"); };
        if (name(owned.getSlot(target).getItem()).equals(item)) return;
        int source = playerSlot(item);
        if (source < 0) throw new IllegalArgumentException("Item is not in your inventory: " + item);
        if (!owned.getSlot(target).mayPlace(owned.getSlot(source).getItem())) throw new IllegalArgumentException("That item does not fit this equipment slot");
        cursorHome = source;
        clicks.add(new Click(source, 0, ClickType.PICKUP)); clicks.add(new Click(target, 0, ClickType.PICKUP)); clicks.add(new Click(source, 0, ClickType.PICKUP));
    }
    private void openStation(String name) {
        if (args.has("furnace_position") && !args.get("furnace_position").isJsonNull()) {
            var pos = ActionValidation.object(args, "furnace_position");
            station = BlockPos.containing(ActionValidation.number(pos, "x", Double.NaN, -30000000, 30000000), ActionValidation.number(pos, "y", Double.NaN, -2048, 2048), ActionValidation.number(pos, "z", Double.NaN, -30000000, 30000000));
            if (!BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(station).getBlock()).getPath().equals(name)) throw new IllegalArgumentException("Requested furnace position is not a furnace");
        } else station = nearest(name);
        if (station == null) {
            if (!args.has("allow_place") || !args.get("allow_place").getAsBoolean()) throw new IllegalArgumentException("No reachable station and station placement is disabled by the server profile");
            select(name);
            BlockPos origin = client.player.blockPosition();
            for (BlockPos pos : BlockPos.betweenClosed(origin.offset(-2, -1, -2), origin.offset(2, 0, 2))) {
                if (!client.level.getBlockState(pos).canBeReplaced() || client.level.getBlockState(pos.below()).getCollisionShape(client.level, pos.below()).isEmpty()
                    || pos.equals(origin) || pos.equals(origin.below()) || !inReach(pos.below())) continue;
                station = pos.immutable();
                var hit = new BlockHitResult(Vec3.atCenterOf(pos.below()).add(0, 0.5, 0), Direction.UP, pos.below(), false);
                client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, hit);
                phase = "placed"; awaitingSince = System.nanoTime(); return;
            }
            throw new IllegalArgumentException("No reachable supported free space to place " + name);
        }
        interact(station); phase = "open"; awaitingSince = System.nanoTime();
    }
    private BlockPos nearest(String name) {
        BlockPos origin = client.player.blockPosition(), best = null; double distance = Double.MAX_VALUE;
        for (BlockPos pos : BlockPos.betweenClosed(origin.offset(-4, -3, -4), origin.offset(4, 3, 4))) {
            if (!client.level.hasChunkAt(pos) || !BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(pos).getBlock()).getPath().equals(name) || !inReach(pos)) continue;
            double d = client.player.distanceToSqr(Vec3.atCenterOf(pos)); if (d < distance) { best = pos.immutable(); distance = d; }
        }
        return best;
    }
    private boolean inReach(BlockPos pos) { return client.player.getEyePosition().distanceTo(Vec3.atCenterOf(pos)) <= client.player.blockInteractionRange(); }
    private void interact(BlockPos pos) {
        if (!inReach(pos)) throw new IllegalArgumentException("Station/container is outside normal interaction reach");
        client.gameMode.useItemOn(client.player, InteractionHand.MAIN_HAND, new BlockHitResult(Vec3.atCenterOf(pos), Direction.UP, pos, false));
    }
    private int playerSlot(String item) {
        for (Slot slot : owned.slots) if (slot.container == client.player.getInventory() && !slot.getItem().isEmpty() && name(slot.getItem()).equals(item)) return slot.index;
        return -1;
    }
    private void transferOne(int source, int target) {
        if (source < 0 || target < 0 || !owned.getCarried().isEmpty()) throw new IllegalArgumentException("Cannot transfer the requested item");
        cursorHome = source;
        clicks.add(new Click(source, 0, ClickType.PICKUP)); clicks.add(new Click(target, 1, ClickType.PICKUP)); clicks.add(new Click(source, 0, ClickType.PICKUP));
    }
    JsonObject tick() {
        if (++ticks % 2 != 0) return null;
        if (phase.equals("placed")) {
            String expected = action.equals("craft_item") ? "crafting_table" : "furnace";
            if (BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(station).getBlock()).getPath().equals(expected)) { interact(station); phase = "open"; awaitingSince = System.nanoTime(); }
            else if (System.nanoTime() - awaitingSince > 5_000_000_000L) throw new IllegalArgumentException("Station placement was not confirmed by Minecraft");
            return null;
        }
        if (phase.equals("open")) {
            if (expectedMenu(client.player.containerMenu)) { owned = client.player.containerMenu; phase = action.equals("craft_item") ? "clear" : action.equals("smelt_item") ? "smelt-start" : "container"; }
            else if (System.nanoTime() - awaitingSince > 5_000_000_000L) throw new IllegalArgumentException("Minecraft did not open the requested station/container");
            return null;
        }
        if (client.player.containerMenu != owned) throw new IllegalArgumentException("The inventory window changed; no further clicks were sent");
        if (!clicks.isEmpty()) {
            Click click = clicks.removeFirst();
            client.gameMode.handleInventoryMouseClick(owned.containerId, click.slot(), click.button(), click.type(), client.player);
            return null;
        }
        if (!owned.getCarried().isEmpty()) throw new IllegalArgumentException("Inventory transfer did not settle; returning the carried item");
        if (phase.equals("equip")) {
            String destination = ActionValidation.string(args, "destination", "hand", 32);
            int slot = switch (destination) { case "head" -> 5; case "torso" -> 6; case "legs" -> 7; case "feet" -> 8; case "off-hand" -> 45; default -> -1; };
            var stack = slot < 0 ? client.player.getMainHandItem() : owned.getSlot(slot).getItem();
            if (!name(stack).equals(item)) throw new IllegalArgumentException("Equipment change was not confirmed");
            return done("equipped", 1);
        }
        if (action.equals("craft_item")) return craftTick();
        if (action.equals("smelt_item")) return smeltTick();
        return containerTick();
    }
    private JsonObject craftTick() {
        int size = table ? 3 : 2;
        if (count(output) - initial >= amount) phase = "clear";
        if (phase.equals("clear")) {
            for (int slot = 1; slot <= size * size; slot++) if (!owned.getSlot(slot).getItem().isEmpty()) {
                if (!hasRoom(owned.getSlot(slot).getItem())) throw new IllegalArgumentException("No inventory room to clear the crafting grid");
                clicks.add(new Click(slot, 0, ClickType.QUICK_MOVE)); return null;
            }
            if (count(output) - initial >= amount) return done("crafted", count(output) - initial);
            phase = "fill"; cell = 0;
        }
        if (phase.equals("fill")) {
            JsonArray grid = args.getAsJsonArray("grid");
            while (cell < size * size) {
                int row = cell / size, column = cell % size, target = 1 + cell++;
                if (row >= grid.size() || column >= grid.get(row).getAsJsonArray().size()) continue;
                var value = grid.get(row).getAsJsonArray().get(column);
                if (value.isJsonNull()) continue;
                int source = playerSlot(value.getAsString());
                if (source < 0) throw new IllegalArgumentException("Missing crafting ingredient: " + value.getAsString());
                transferOne(source, target); return null;
            }
            phase = "result"; awaitingSince = System.nanoTime();
        }
        if (phase.equals("result")) {
            var result = owned.getSlot(0).getItem();
            if (!result.isEmpty()) {
                if (!name(result).equals(output)) throw new IllegalArgumentException("Minecraft's recipe output does not match the requested item");
                if (!hasRoom(result)) throw new IllegalArgumentException("No inventory room for crafting output");
                previousCount = count(output); clicks.add(new Click(0, 0, ClickType.QUICK_MOVE)); phase = "craft-confirm"; awaitingSince = System.nanoTime(); return null;
            }
            if (System.nanoTime() - awaitingSince > 5_000_000_000L) throw new IllegalArgumentException("Minecraft did not accept the supplied crafting recipe");
        }
        if (phase.equals("craft-confirm")) {
            if (count(output) > previousCount) phase = "clear";
            else if (System.nanoTime() - awaitingSince > 5_000_000_000L) throw new IllegalArgumentException("Craft output did not enter the inventory");
        }
        return null;
    }
    private JsonObject smeltTick() {
        if (count(output) - initial >= amount) return done("smelted", count(output) - initial);
        if (phase.equals("smelt-start")) {
            if (!owned.getSlot(0).getItem().isEmpty() || !owned.getSlot(2).getItem().isEmpty()) throw new IllegalArgumentException("Use an empty furnace; existing input/output was left untouched");
            if (count(item) < amount) throw new IllegalArgumentException("Not enough smelting input");
            phase = "fuel";
        }
        String fuel = ActionValidation.string(args, "fuel", "coal", 128);
        if (!fuel.equals("coal") && !fuel.equals("charcoal")) throw new IllegalArgumentException("This smelting routine currently supports coal or charcoal fuel");
        if (phase.equals("fuel")) {
            var current = owned.getSlot(1).getItem();
            if (!current.isEmpty() && !name(current).equals(fuel)) throw new IllegalArgumentException("Furnace contains a different fuel; left untouched");
            if (current.getCount() < Math.ceil(amount / 8.0)) { transferOne(playerSlot(fuel), 1); return null; }
            phase = "input"; moved = 0;
        }
        if (phase.equals("input")) {
            if (moved++ < amount) { transferOne(playerSlot(item), 0); return null; }
            phase = "smelting";
        }
        var result = owned.getSlot(2).getItem();
        if (!result.isEmpty()) {
            if (!name(result).equals(output)) throw new IllegalArgumentException("Unexpected furnace output");
            if (!hasRoom(result)) throw new IllegalArgumentException("No inventory room for smelting output");
            clicks.add(new Click(2, 0, ClickType.QUICK_MOVE));
        }
        return null;
    }
    private JsonObject containerTick() {
        if (action.equals("inspect_container")) {
            JsonObject result = new JsonObject(); JsonArray items = new JsonArray();
            for (Slot slot : owned.slots) if (slot.container != client.player.getInventory() && !slot.getItem().isEmpty()) {
                JsonObject value = new JsonObject(); value.addProperty("name", name(slot.getItem())); value.addProperty("count", slot.getItem().getCount()); value.addProperty("slot", slot.index); items.add(value);
            }
            result.add("items", items); return result;
        }
        boolean deposit = action.equals("deposit_item");
        int observed = deposit ? initial - count(item) : count(item) - initial;
        if (phase.equals("transfer-confirm")) {
            if (observed >= moved) phase = "container";
            else if (System.nanoTime() - awaitingSince > 5_000_000_000L) throw new IllegalArgumentException("Container transfer was not reflected in inventory; moved " + observed);
            else return null;
        }
        if (observed >= amount) return done("transferred", observed);
        int source = -1, target = -1;
        for (Slot slot : owned.slots) {
            boolean player = slot.container == client.player.getInventory();
            var stack = slot.getItem();
            if (player == deposit && !stack.isEmpty() && name(stack).equals(item)) source = slot.index;
        }
        if (source < 0) throw new IllegalArgumentException("Requested source item is unavailable; moved " + moved);
        var sourceStack = owned.getSlot(source).getItem();
        for (Slot slot : owned.slots) {
            if ((slot.container == client.player.getInventory()) == deposit || !slot.mayPlace(sourceStack)) continue;
            var stack = slot.getItem();
            if (stack.isEmpty() || (ItemStack.isSameItemSameComponents(stack, sourceStack) && stack.getCount() < slot.getMaxStackSize(sourceStack))) { target = slot.index; break; }
        }
        if (target < 0) throw new IllegalArgumentException("Destination has no room; moved " + moved);
        transferOne(source, target); moved = observed + 1; phase = "transfer-confirm"; awaitingSince = System.nanoTime(); return null;
    }
    boolean hasRoom(ItemStack incoming) {
        int capacity = 0;
        for (int i = 0; i < 36; i++) {
            var stack = client.player.getInventory().getItem(i);
            if (stack.isEmpty()) capacity += incoming.getMaxStackSize();
            else if (ItemStack.isSameItemSameComponents(stack, incoming)) capacity += stack.getMaxStackSize() - stack.getCount();
        }
        return capacity >= incoming.getCount();
    }
    private JsonObject done(String key, int amount) { JsonObject result = new JsonObject(); result.addProperty(key, amount); result.addProperty("item", item); result.addProperty("verified", true); return result; }
    void cancel() {
        clicks.clear();
        if (owned != null && client.player != null && client.player.containerMenu == owned) {
            if (!owned.getCarried().isEmpty() && cursorHome >= 0) {
                var home = owned.getSlot(cursorHome);
                if (home.getItem().isEmpty() || ItemStack.isSameItemSameComponents(home.getItem(), owned.getCarried())) client.gameMode.handleInventoryMouseClick(owned.containerId, cursorHome, 0, ClickType.PICKUP, client.player);
            }
            if (!owned.getCarried().isEmpty()) for (Slot slot : owned.slots) {
                if (slot.container == client.player.getInventory() && slot.getItem().isEmpty() && slot.mayPlace(owned.getCarried())) {
                    client.gameMode.handleInventoryMouseClick(owned.containerId, slot.index, 0, ClickType.PICKUP, client.player); break;
                }
            }
            // Keep the menu open for human recovery if the cursor/grid cannot fit; never drop items to finish a cancellation.
            boolean canClose = owned.getCarried().isEmpty();
            int gridSize = action != null && action.equals("craft_item") ? (table ? 9 : 4) : 0;
            for (int i = 1; i <= gridSize; i++) if (!owned.getSlot(i).getItem().isEmpty()) canClose = false;
            if (canClose && client.screen != null) client.player.closeContainer();
        }
        owned = null; phase = null; cursorHome = -1; action = null;
    }
}

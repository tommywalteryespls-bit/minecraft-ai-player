package dev.astra.voice;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

final class WorldSnapshot {
    private WorldSnapshot() {}
    static JsonObject position(Vec3 point) {
        JsonObject out = new JsonObject();
        out.addProperty("x", point.x); out.addProperty("y", point.y); out.addProperty("z", point.z);
        return out;
    }
    static JsonObject block(Minecraft client, BlockPos pos) {
        JsonObject out = new JsonObject();
        out.addProperty("name", BuiltInRegistries.BLOCK.getKey(client.level.getBlockState(pos).getBlock()).getPath());
        out.add("position", position(new Vec3(pos.getX(), pos.getY(), pos.getZ())));
        out.addProperty("distance", client.player.position().distanceTo(Vec3.atCenterOf(pos)));
        return out;
    }
    private static JsonObject item(ItemStack stack, int slot) {
        JsonObject out = new JsonObject();
        out.addProperty("name", BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath());
        out.addProperty("displayName", stack.getHoverName().getString());
        out.addProperty("count", stack.getCount()); out.addProperty("slot", slot);
        return out;
    }
    static JsonObject capture(Minecraft client, String actionState) {
        JsonObject out = new JsonObject();
        var player = client.player;
        var level = client.level;
        out.addProperty("serverId", "fabric-client"); out.addProperty("connected", true);
        out.addProperty("dimension", level.dimension().identifier().toString());
        out.addProperty("day", level.getDayTime() / 24000); out.addProperty("time", level.getDayTime() % 24000);
        out.add("position", position(player.position()));
        out.addProperty("yaw", player.getYRot()); out.addProperty("pitch", player.getXRot());
        out.addProperty("health", player.getHealth()); out.addProperty("hunger", player.getFoodData().getFoodLevel());
        out.addProperty("armor", player.getArmorValue());
        JsonArray items = new JsonArray(); int free = 0;
        for (int slot = 0; slot < 36; slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (stack.isEmpty()) free++; else items.add(item(stack, slot));
        }
        JsonObject inventory = new JsonObject(); inventory.add("items", items); inventory.addProperty("freeSlots", free);
        out.add("inventory", inventory);
        JsonArray equipped = new JsonArray();
        for (EquipmentSlot slot : EquipmentSlot.values()) {
            ItemStack stack = player.getItemBySlot(slot);
            if (!stack.isEmpty()) equipped.add(item(stack, slot.ordinal()));
        }
        out.add("equippedItems", equipped);
        JsonArray players = new JsonArray(), hostiles = new JsonArray(), passive = new JsonArray(), drops = new JsonArray();
        int inspected = 0;
        for (Entity entity : level.entitiesForRendering()) {
            if (++inspected > 2048) break;
            if (entity == player || !entity.isAlive() || entity.distanceToSqr(player) > 64 * 64) continue;
            String kind = entity instanceof Player ? "player" : entity instanceof Enemy ? "hostile" : entity instanceof ItemEntity ? "item" : entity instanceof Mob ? "passive" : "other";
            JsonArray target = switch (kind) { case "player" -> players; case "hostile" -> hostiles; case "item" -> drops; case "passive" -> passive; default -> null; };
            if (target == null || target.size() >= 32) continue;
            JsonObject data = new JsonObject();
            data.addProperty("id", Integer.toString(entity.getId())); data.addProperty("uuid", entity.getStringUUID());
            data.addProperty("name", entity.getName().getString()); data.addProperty("kind", kind);
            if (entity instanceof Player) data.addProperty("username", entity.getName().getString());
            data.add("position", position(entity.position())); data.addProperty("distance", entity.distanceTo(player));
            target.add(data);
        }
        out.add("nearbyPlayers", players); out.add("nearbyHostiles", hostiles); out.add("nearbyPassiveMobs", passive); out.add("droppedItems", drops);
        JsonArray blocks = new JsonArray();
        BlockPos origin = player.blockPosition();
        for (BlockPos pos : BlockPos.betweenClosed(origin.offset(-4, -2, -4), origin.offset(4, 3, 4))) {
            if (blocks.size() >= 48) break;
            if (!level.hasChunkAt(pos) || level.getBlockState(pos).isAir()) continue;
            String name = BuiltInRegistries.BLOCK.getKey(level.getBlockState(pos).getBlock()).getPath();
            if (name.contains("ore") || name.endsWith("log") || name.contains("chest") || name.equals("crafting_table") || name.contains("furnace")) blocks.add(block(client, pos));
        }
        out.add("nearbyUsefulBlocks", blocks);
        if (client.hitResult instanceof BlockHitResult hit && !level.getBlockState(hit.getBlockPos()).isAir()) out.add("targetBlock", block(client, hit.getBlockPos()));
        JsonArray threats = new JsonArray();
        if (player.isOnFire()) threat(threats, "fire", "critical", "The player is on fire");
        if (player.isInLava()) threat(threats, "lava", "critical", "The player is in lava");
        if (player.getAirSupply() < 60) threat(threats, "drowning", "critical", "Air supply is low");
        if (player.getFoodData().getFoodLevel() < 5) threat(threats, "starvation", "medium", "Hunger is low");
        if (!hostiles.isEmpty()) threat(threats, "hostile", "medium", "Hostile entities are loaded nearby");
        out.add("environmentalThreats", threats); out.addProperty("currentAction", actionState); out.add("currentGoals", new JsonArray());
        return out;
    }
    private static void threat(JsonArray list, String type, String severity, String description) {
        JsonObject data = new JsonObject(); data.addProperty("type", type); data.addProperty("severity", severity); data.addProperty("description", description); list.add(data);
    }
}

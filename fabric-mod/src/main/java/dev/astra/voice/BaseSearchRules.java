package dev.astra.voice;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Pure boundaries for the dedicated two-cell strip-mining action, not general navigation. */
final class BaseSearchRules {
    record Cell(int x, int y, int z) {}
    private static final Set<String> NATURAL_TERRAIN = Set.of(
        "air", "cave_air", "void_air", "stone", "granite", "diorite", "andesite", "deepslate", "tuff", "calcite",
        "dirt", "coarse_dirt", "rooted_dirt", "grass_block", "podzol", "mycelium", "mud", "clay", "sand", "red_sand", "gravel",
        "sandstone", "red_sandstone", "terracotta", "snow", "snow_block", "ice", "packed_ice", "blue_ice",
        "coal_ore", "iron_ore", "copper_ore", "gold_ore", "redstone_ore", "lapis_ore", "diamond_ore", "emerald_ore",
        "deepslate_coal_ore", "deepslate_iron_ore", "deepslate_copper_ore", "deepslate_gold_ore", "deepslate_redstone_ore",
        "deepslate_lapis_ore", "deepslate_diamond_ore", "deepslate_emerald_ore", "raw_iron_block", "raw_copper_block",
        "dripstone_block", "pointed_dripstone", "moss_block", "moss_carpet", "netherrack", "basalt", "smooth_basalt", "blackstone",
        "soul_sand", "soul_soil", "nether_gold_ore", "nether_quartz_ore", "ancient_debris", "end_stone"
    );
    private static final Set<String> AMBIENT_NATURAL = Set.of(
        "water", "lava", "bubble_column", "fire", "soul_fire", "magma_block", "powder_snow", "bedrock", "obsidian",
        "short_grass", "tall_grass", "fern", "large_fern", "dead_bush", "vine", "glow_lichen", "hanging_roots",
        "cave_vines", "cave_vines_plant", "seagrass", "tall_seagrass", "kelp", "kelp_plant", "lily_pad", "sugar_cane",
        "brown_mushroom", "red_mushroom", "brown_mushroom_block", "red_mushroom_block", "mushroom_stem",
        "crimson_roots", "warped_roots", "nether_sprouts", "twisting_vines", "twisting_vines_plant", "weeping_vines",
        "weeping_vines_plant", "crimson_nylium", "warped_nylium", "amethyst_block", "budding_amethyst", "amethyst_cluster",
        "small_amethyst_bud", "medium_amethyst_bud", "large_amethyst_bud", "sculk", "sculk_vein", "sculk_catalyst",
        "sculk_sensor", "sculk_shrieker", "white_terracotta", "orange_terracotta", "yellow_terracotta", "brown_terracotta",
        "red_terracotta", "light_gray_terracotta"
    );
    private static final List<Cell> CORRIDOR_PROBE = offsets(2, -2, 3);
    private BaseSearchRules() {}

    static boolean adjacentStep(Cell origin, Cell target) {
        return origin.y == target.y && Math.abs((long)origin.x-target.x) + Math.abs((long)origin.z-target.z) == 1;
    }
    static int coordinate(double value) {
        if (!Double.isFinite(value) || value != Math.rint(value) || value < -29999984 || value > 29999984)
            throw new IllegalArgumentException("Search step coordinates must be whole block coordinates");
        return (int)value;
    }
    static int radius(double value) {
        if (!Double.isFinite(value) || value != Math.rint(value) || value < 1 || value > 6)
            throw new IllegalArgumentException("Search scan radius must be a whole number between 1 and 6");
        return (int)value;
    }
    static boolean naturalTerrain(String id) { return NATURAL_TERRAIN.contains(vanillaName(id)); }
    static boolean structureClue(String id) {
        String name = vanillaName(id);
        // Logs are deliberately not excluded: underground timber can be a mineshaft or construction.
        // This is suspicion only; neither natural generation nor player placement can be proven.
        return !NATURAL_TERRAIN.contains(name) && !AMBIENT_NATURAL.contains(name);
    }
    static List<Cell> cubeOffsets(int radius) { return offsets(radius(radius), -radius, radius); }
    static List<Cell> corridorProbe() { return CORRIDOR_PROBE; }
    private static String vanillaName(String id) { return id.startsWith("minecraft:") ? id.substring(10) : id; }
    private static List<Cell> offsets(int radius, int minY, int maxY) {
        List<Cell> cells = new ArrayList<>();
        for (int x=-radius; x<=radius; x++) for (int y=minY; y<=maxY; y++) for (int z=-radius; z<=radius; z++) cells.add(new Cell(x,y,z));
        return List.copyOf(cells);
    }
}

package dev.astra.voice;

import java.util.HashSet;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class BaseSearchRulesTest {
    @Test void onlyOneHorizontalCardinalStepIsAccepted() {
        var origin = new BaseSearchRules.Cell(-10, -54, 20);
        for (var target : new BaseSearchRules.Cell[]{new BaseSearchRules.Cell(-9,-54,20), new BaseSearchRules.Cell(-11,-54,20), new BaseSearchRules.Cell(-10,-54,19), new BaseSearchRules.Cell(-10,-54,21)}) assertTrue(BaseSearchRules.adjacentStep(origin,target));
        for (var target : new BaseSearchRules.Cell[]{origin, new BaseSearchRules.Cell(-9,-54,21), new BaseSearchRules.Cell(-10,-53,20), new BaseSearchRules.Cell(-8,-54,20), new BaseSearchRules.Cell(Integer.MAX_VALUE,-54,20)}) assertFalse(BaseSearchRules.adjacentStep(origin,target));
    }
    @Test void coordinatesAndRadiiCannotBeSilentlyRounded() {
        assertEquals(-54, BaseSearchRules.coordinate(-54));
        for (double value : new double[]{0.5, -54.25, Double.NaN, Double.POSITIVE_INFINITY, 30000000}) assertThrows(IllegalArgumentException.class, () -> BaseSearchRules.coordinate(value));
        for (double value : new double[]{0, 7, 2.5, Double.NaN}) assertThrows(IllegalArgumentException.class, () -> BaseSearchRules.radius(value));
        assertEquals(6, BaseSearchRules.radius(6));
    }
    @Test void excavationUsesAnExactNaturalAllowlistNotNameFragments() {
        for (String name : new String[]{"stone", "minecraft:deepslate", "diamond_ore", "gravel", "tuff"}) assertTrue(BaseSearchRules.naturalTerrain(name), name);
        for (String name : new String[]{"stone_bricks", "cobblestone", "oak_log", "oak_planks", "stone_slab", "chest", "torch", "red_bed", "water", "lava", "bedrock", "mod:stone", "mod:diamond_ore"}) assertFalse(BaseSearchRules.naturalTerrain(name), name);
    }
    @Test void constructionStorageLightsAndUnknownBlocksAreSuspicionsNotProof() {
        for (String name : new String[]{"stone_bricks", "crafting_table", "furnace", "chest", "barrel", "white_bed", "oak_door", "torch", "wall_torch", "redstone_wire", "mod:unknown_block"}) assertTrue(BaseSearchRules.structureClue(name), name);
        for (String name : new String[]{"air", "minecraft:stone", "water", "lava", "bedrock", "glow_lichen", "cave_vines", "sculk"}) assertFalse(BaseSearchRules.structureClue(name), name);
    }
    @Test void scansContainEveryCellIncludingAirPositionsWithoutDuplicates() {
        var cube = BaseSearchRules.cubeOffsets(6);
        assertEquals(2197, cube.size()); assertEquals(cube.size(), new HashSet<>(cube).size());
        assertTrue(cube.contains(new BaseSearchRules.Cell(-6,-6,-6))); assertTrue(cube.contains(new BaseSearchRules.Cell(6,6,6)));
        assertEquals(729, BaseSearchRules.cubeOffsets(4).size());
    }
    @Test void preBreakProbeSurroundsBothTargetFeetAndHeadByTwoCells() {
        var probe = BaseSearchRules.corridorProbe(); assertEquals(150, probe.size()); assertEquals(150, new HashSet<>(probe).size());
        assertTrue(probe.contains(new BaseSearchRules.Cell(-2,-2,-2))); assertTrue(probe.contains(new BaseSearchRules.Cell(2,3,2)));
        assertFalse(probe.contains(new BaseSearchRules.Cell(0,4,0)));
    }
}

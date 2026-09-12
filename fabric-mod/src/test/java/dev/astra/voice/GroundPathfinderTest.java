package dev.astra.voice;

import java.util.Set;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class GroundPathfinderTest {
    private GroundPathfinder.Cell cell(int x, int y, int z) { return new GroundPathfinder.Cell(x, y, z); }
    private GroundPathfinder.Terrain terrain(Set<GroundPathfinder.Cell> obstacles, boolean dig) {
        return new GroundPathfinder.Terrain() {
            public double bodyCost(GroundPathfinder.Cell c) { return c.y() < 0 ? Double.POSITIVE_INFINITY : obstacles.contains(c) ? (dig ? 8 : Double.POSITIVE_INFINITY) : 0; }
            public boolean support(GroundPathfinder.Cell c) { return c.y() == -1 || obstacles.contains(c); }
        };
    }
    @Test void walksToTargetOnGround() {
        var path = GroundPathfinder.find(cell(0,0,0), cell(5,0,0), 0, terrain(Set.of(), false), 100);
        assertEquals(5, path.size()); assertEquals(cell(5,0,0), path.getLast());
    }
    @Test void routesAroundSolidWallWithoutBreaking() {
        var wall = Set.of(cell(1,0,0), cell(1,1,0), cell(1,2,0));
        var path = GroundPathfinder.find(cell(0,0,0), cell(3,0,0), 0, terrain(wall, false), 200);
        assertEquals(cell(3,0,0), path.getLast()); assertTrue(path.stream().noneMatch(wall::contains)); assertTrue(path.size() > 3);
    }
    @Test void oneBlockStairsAreTraversable() {
        var path = GroundPathfinder.find(cell(0,0,0), cell(1,1,0), 0, terrain(Set.of(cell(1,0,0)), false), 100);
        assertEquals(cell(1,1,0), path.getLast());
    }
    @Test void excavationCanEnterSolidTerrainWhenNoOpenRouteExists() {
        var terrain = new GroundPathfinder.Terrain() {
            public double bodyCost(GroundPathfinder.Cell c) { return c.z() != 0 || c.y() < 0 || c.y() > 1 ? Double.POSITIVE_INFINITY : c.x() > 0 ? 8 : 0; }
            public boolean support(GroundPathfinder.Cell c) { return c.y() == -1; }
        };
        var path = GroundPathfinder.find(cell(0,0,0), cell(3,0,0), 0, terrain, 100);
        assertEquals(cell(3,0,0), path.getLast());
    }
    @Test void refusesUnsupportedAirAndUnloadedTerrain() {
        var terrain = new GroundPathfinder.Terrain() { public double bodyCost(GroundPathfinder.Cell c) { return Double.POSITIVE_INFINITY; } public boolean support(GroundPathfinder.Cell c) { return false; } };
        assertTrue(GroundPathfinder.find(cell(0,0,0), cell(3,0,0), 0, terrain, 100).isEmpty());
    }
    @Test void searchBudgetReturnsProgressSegmentInsteadOfUnboundedCpuWork() {
        var path = GroundPathfinder.find(cell(0,0,0), cell(10000,0,0), 0, terrain(Set.of(), false), 8);
        assertFalse(path.isEmpty()); assertTrue(path.size() < 8); assertTrue(path.getLast().x() > 0);
    }
    @Test void equipmentOrdinalsMatchTheFabricInventoryContract() {
        assertEquals(0, net.minecraft.world.entity.EquipmentSlot.MAINHAND.ordinal());
        assertEquals(2, net.minecraft.world.entity.EquipmentSlot.FEET.ordinal());
        assertEquals(5, net.minecraft.world.entity.EquipmentSlot.HEAD.ordinal());
    }
    @Test void radiusDoesNotFinishOnTheWrongFloor() {
        var path = GroundPathfinder.find(cell(0,0,0), cell(1,1,0), 2, terrain(Set.of(cell(1,0,0)), false), 100);
        assertFalse(path.isEmpty()); assertEquals(1, path.getLast().y());
    }
}

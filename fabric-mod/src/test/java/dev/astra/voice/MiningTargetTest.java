package dev.astra.voice;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MiningTargetTest {
    @Test void waterLeftByWaterloggedBlockCompletesOriginalTarget() {
        assertTrue(new MiningTarget("minecraft:oak_fence").removedOrReplaced("minecraft:water"));
    }

    @Test void airOrDifferentBlockEndsTheOriginalTargetWithoutContinuingIntoReplacement() {
        MiningTarget target = new MiningTarget("minecraft:stone");
        assertTrue(target.removedOrReplaced("minecraft:air"));
        assertTrue(target.removedOrReplaced("minecraft:cobblestone"));
    }

    @Test void sameBlockIdentityContinuesEvenWhenPropertiesMayChange() {
        assertFalse(new MiningTarget("minecraft:oak_fence").removedOrReplaced("minecraft:oak_fence"));
    }
}

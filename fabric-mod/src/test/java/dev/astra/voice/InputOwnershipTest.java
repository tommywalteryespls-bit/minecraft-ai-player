package dev.astra.voice;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class InputOwnershipTest {
    @Test void ongoingInputsAreReassertedAfterExternalKeyRelease() {
        Map<String, Boolean> actual = new HashMap<>();
        var ownership = new InputOwnership<String>(key -> false, actual::put);
        ownership.hold("walk"); ownership.hold("jump");
        actual.put("walk", false); actual.put("jump", false);
        ownership.resume();
        assertEquals(true, actual.get("walk")); assertEquals(true, actual.get("jump"));
    }
    @Test void menuSuspensionRetainsIntentWithoutSyntheticClicks() {
        Map<String, Boolean> actual = new HashMap<>();
        var ownership = new InputOwnership<String>(key -> false, actual::put);
        ownership.hold("attack"); ownership.suspend(); ownership.hold("use");
        assertEquals(false, actual.get("attack")); assertEquals(false, actual.get("use"));
        ownership.resume();
        assertEquals(true, actual.get("attack")); assertEquals(true, actual.get("use"));
    }
    @Test void stoppingPreservesPhysicalKeysAndForgetsSyntheticOwnership() {
        Map<String, Boolean> actual = new HashMap<>();
        Set<String> physical = new HashSet<>(Set.of("walk"));
        var ownership = new InputOwnership<String>(physical::contains, actual::put);
        ownership.hold("walk"); ownership.hold("attack");
        actual.put("unowned", true);
        ownership.releaseAll();
        assertEquals(true, actual.get("walk")); assertEquals(false, actual.get("attack"));
        assertEquals(true, actual.get("unowned"));
        actual.put("walk", false); ownership.resume();
        assertEquals(false, actual.get("walk")); assertEquals(false, actual.get("attack"));
    }
}

package dev.astra.voice;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ActionValidationTest {
    private JsonObject action(String name, String command) {
        JsonObject message = new JsonObject();
        message.addProperty("action", name); message.addProperty("sessionId", "world-one"); message.addProperty("controlEpoch", 4);
        JsonObject args = new JsonObject(); args.addProperty("command", command); message.add("arguments", args); return message;
    }
    @Test void ordinaryActionsRequireArmAndCurrentWorldAndEpoch() {
        JsonObject action = action("control_player", "walk");
        assertTrue(ActionValidation.accepts("world-one", 4, true, action));
        assertFalse(ActionValidation.accepts("world-one", 4, false, action));
        assertFalse(ActionValidation.accepts("world-two", 4, true, action));
        assertFalse(ActionValidation.accepts("world-one", 5, true, action));
    }
    @Test void stopRemainsAllowedWhileDisarmedButNeverInStaleWorld() {
        assertTrue(ActionValidation.accepts("world-one", 4, false, action("control_player", "stop")));
        assertTrue(ActionValidation.accepts("world-one", 4, false, action("stop_following", "")));
        assertFalse(ActionValidation.accepts("world-two", 4, false, action("control_player", "stop")));
    }
    @Test void refusesUnadvertisedActions() {
        for (String action : new String[] {"teleport", "execute", "command", "run_code", ""}) assertFalse(ActionValidation.accepts("world-one", 4, true, action(action, "")));
    }
    @Test void gameplayActionsStillRequireCurrentWorldAndArming() {
        for (String name : new String[] {"craft_item", "smelt_item", "pickup_items", "place_block", "inspect_container", "deposit_item", "withdraw_item", "equip_item", "scan_search_area", "base_search_step"}) {
            assertTrue(ActionValidation.accepts("world-one", 4, true, action(name, "")));
            assertFalse(ActionValidation.accepts("world-one", 4, false, action(name, "")));
            assertFalse(ActionValidation.accepts("world-two", 4, true, action(name, "")));
        }
    }
    @Test void refusesNonFiniteOrOutOfBoundsNumbers() {
        JsonObject args = new JsonObject();
        for (double value : new double[] {Double.NaN, Double.POSITIVE_INFINITY, -181, 181}) {
            args.addProperty("yaw", value); assertThrows(IllegalArgumentException.class, () -> ActionValidation.number(args, "yaw", 0, -180, 180));
        }
        args.addProperty("yaw", "90"); assertThrows(IllegalArgumentException.class, () -> ActionValidation.number(args, "yaw", 0, -180, 180));
    }
    @Test void rejectsMissingRequiredCoordinatesAndAllowsOptionalDefaults() {
        JsonObject args = new JsonObject();
        assertThrows(IllegalArgumentException.class, () -> ActionValidation.number(args, "x", Double.NaN, -1000, 1000));
        assertEquals(1000, ActionValidation.number(args, "duration_ms", 1000, 50, 10000));
    }
    @Test void validatesShapeAndStringSize() {
        JsonObject args = new JsonObject(); args.addProperty("name", 123);
        assertThrows(IllegalArgumentException.class, () -> ActionValidation.string(args, "name", "", 10));
        args.addProperty("name", "a".repeat(11));
        assertThrows(IllegalArgumentException.class, () -> ActionValidation.string(args, "name", "", 10));
        assertThrows(IllegalArgumentException.class, () -> ActionValidation.object(args, "arguments"));
    }
}

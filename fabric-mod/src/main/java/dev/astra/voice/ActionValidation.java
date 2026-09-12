package dev.astra.voice;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Set;

/** Small pure-Java boundary shared by the client controller and regression tests. */
public final class ActionValidation {
    public static final Set<String> SUPPORTED = Set.of("control_player", "look_at", "move_to", "move_near", "follow_player",
        "stop_following", "find_block", "mine_block", "equip_item", "eat_best_food", "say", "craft_item", "smelt_item",
        "pickup_items", "place_block", "inspect_container", "deposit_item", "withdraw_item", "scan_search_area", "base_search_step");
    private ActionValidation() {}

    public static String string(JsonObject args, String key, String fallback, int maxLength) {
        JsonElement value = args.get(key);
        if (value == null || value.isJsonNull()) return fallback;
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw new IllegalArgumentException(key + " must be text");
        String result = value.getAsString();
        if (result.length() > maxLength) throw new IllegalArgumentException(key + " is too long");
        return result;
    }

    public static double number(JsonObject args, String key, double fallback, double min, double max) {
        JsonElement value = args.get(key);
        if (value == null || value.isJsonNull()) {
            if (!Double.isFinite(fallback)) throw new IllegalArgumentException(key + " is required");
            return fallback;
        }
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException(key + " must be a number");
        double result = value.getAsDouble();
        if (!Double.isFinite(result) || result < min || result > max) throw new IllegalArgumentException(key + " is outside allowed limits");
        return result;
    }

    public static JsonObject object(JsonObject args, String key) {
        JsonElement value = args.get(key);
        if (value == null || !value.isJsonObject()) throw new IllegalArgumentException(key + " is required");
        return value.getAsJsonObject();
    }

    public static boolean isStop(String action, JsonObject args) {
        return action.equals("stop_following") || (action.equals("control_player") && string(args, "command", "", 32).equals("stop"));
    }

    public static boolean accepts(String currentSession, int currentEpoch, boolean armed, JsonObject message) {
        String action = string(message, "action", "", 64);
        if (!SUPPORTED.contains(action) || !currentSession.equals(string(message, "sessionId", "", 64))) return false;
        if (number(message, "controlEpoch", -1, -1, Integer.MAX_VALUE) != currentEpoch) return false;
        JsonObject args = object(message, "arguments");
        return armed || isStop(action, args);
    }
}

package dev.astra.voice;

import com.google.gson.JsonObject;

/** Local backend policy, accepted only in a welcome addressed to the current session. */
final class ControlPolicy {
    private boolean unrestricted;
    boolean unrestricted() { return unrestricted; }
    void reset() { unrestricted = false; }
    boolean welcome(String sessionId, JsonObject message) {
        if (sessionId == null || !sessionId.equals(ActionValidation.string(message, "sessionId", "", 128))) return false;
        if (ActionValidation.number(message, "protocolVersion", -1, -1, 2) != 2) return false;
        var value = message.get("unrestricted");
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) return false;
        unrestricted = value.getAsBoolean();
        return true;
    }
    long deadline(JsonObject request, long now) {
        long timeout = (long)ActionValidation.number(request, "timeoutMs", unrestricted ? 0 : 30000,
            unrestricted ? 0 : 100, unrestricted ? Integer.MAX_VALUE : 60000);
        return timeout == 0 ? Long.MAX_VALUE : now + timeout * 1_000_000L;
    }
    long duration(JsonObject arguments, String command) {
        long duration = (long)ActionValidation.number(arguments, "duration_ms", command.equals("jump") ? 250 : 1000,
            unrestricted ? 0 : 50, unrestricted ? Integer.MAX_VALUE : 10000);
        if (duration == 0 && !command.equals("walk")) throw new IllegalArgumentException("Only walks support duration_ms=0");
        return duration;
    }
}

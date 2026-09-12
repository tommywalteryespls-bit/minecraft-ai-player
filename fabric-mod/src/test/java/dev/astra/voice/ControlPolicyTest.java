package dev.astra.voice;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ControlPolicyTest {
    private JsonObject json(String text) { return JsonParser.parseString(text).getAsJsonObject(); }
    private ControlPolicy unrestricted() {
        var policy = new ControlPolicy();
        assertTrue(policy.welcome("current", json("{\"sessionId\":\"current\",\"protocolVersion\":2,\"unrestricted\":true}")));
        return policy;
    }
    @Test void policyRequiresCurrentSessionWelcomeAndResets() {
        var policy = new ControlPolicy();
        assertFalse(policy.unrestricted());
        assertFalse(policy.welcome("current", json("{\"sessionId\":\"old\",\"protocolVersion\":2,\"unrestricted\":true}")));
        assertFalse(policy.welcome("current", json("{\"sessionId\":\"current\",\"protocolVersion\":2,\"unrestricted\":\"true\"}")));
        assertFalse(policy.unrestricted());
        policy = unrestricted(); assertTrue(policy.unrestricted());
        policy.reset(); assertFalse(policy.unrestricted());
    }
    @Test void boundedDeadlinesAndDurationsStayBounded() {
        var policy = new ControlPolicy();
        assertEquals(30_000_000_001L, policy.deadline(json("{}"), 1));
        assertThrows(IllegalArgumentException.class, () -> policy.deadline(json("{\"timeoutMs\":0}"), 1));
        assertThrows(IllegalArgumentException.class, () -> policy.duration(json("{\"duration_ms\":0}"), "walk"));
        assertThrows(IllegalArgumentException.class, () -> policy.duration(json("{\"duration_ms\":10001}"), "walk"));
    }
    @Test void unrestrictedHasNoImplicitDeadlineButPreservesRequestedDuration() {
        var policy = unrestricted();
        assertEquals(Long.MAX_VALUE, policy.deadline(json("{}"), 1));
        assertEquals(Long.MAX_VALUE, policy.deadline(json("{\"timeoutMs\":0}"), 1));
        assertEquals(70_000_000_001L, policy.deadline(json("{\"timeoutMs\":70000}"), 1));
        assertEquals(0, policy.duration(json("{\"duration_ms\":0}"), "walk"));
        assertEquals(2000, policy.duration(json("{\"duration_ms\":2000}"), "walk"));
        assertEquals(70000, policy.duration(json("{\"duration_ms\":70000}"), "walk"));
        assertEquals(1000, policy.duration(json("{}"), "walk"));
        assertThrows(IllegalArgumentException.class, () -> policy.duration(json("{\"duration_ms\":0}"), "jump"));
    }
}

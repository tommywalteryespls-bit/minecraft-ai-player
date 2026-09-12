package dev.astra.voice;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class InputSafetyTest {
    @Test void shortPanicTapBetweenTicksStillStops() {
        assertTrue(InputSafety.panicRequested(false, false, true));
    }

    @Test void physicalEdgeStopsEvenWhenGuiDidNotQueueAnEvent() {
        assertTrue(InputSafety.panicRequested(false, true, false));
    }

    @Test void eventAndPhysicalEdgeProduceOneDecisionAndHoldingDoesNotRetrigger() {
        assertTrue(InputSafety.panicRequested(false, true, true));
        assertFalse(InputSafety.panicRequested(true, true, false));
        assertFalse(InputSafety.panicRequested(true, false, false));
        assertFalse(InputSafety.panicRequested(false, false, false));
    }
}

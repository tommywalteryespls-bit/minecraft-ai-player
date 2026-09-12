package dev.astra.voice;

/** Combines persistent physical state with events that may begin and end between ticks. */
final class InputSafety {
    private InputSafety() {}

    static boolean panicRequested(boolean wasPhysicallyDown, boolean physicallyDown, boolean queuedClick) {
        return queuedClick || (physicallyDown && !wasPhysicallyDown);
    }
}

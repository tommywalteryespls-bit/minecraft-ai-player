package dev.astra.voice;

/** Block identity, rather than air alone, also detects water left by a waterlogged block. */
record MiningTarget(String blockId) {
    boolean removedOrReplaced(String currentBlockId) { return !blockId.equals(currentBlockId); }
}

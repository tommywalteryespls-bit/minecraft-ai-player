package dev.astra.voice;

import java.util.HashSet;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Predicate;

/** Pure desired-input state, independent of GLFW and Minecraft key mappings. */
final class InputOwnership<T> {
    private final Set<T> owned = new HashSet<>();
    private final Predicate<T> physicallyDown;
    private final BiConsumer<T, Boolean> setDown;
    private boolean suspended;

    InputOwnership(Predicate<T> physicallyDown, BiConsumer<T, Boolean> setDown) {
        this.physicallyDown = physicallyDown; this.setDown = setDown;
    }
    void hold(T binding) { owned.add(binding); setDown.accept(binding, !suspended || physicallyDown.test(binding)); }
    void suspend() {
        suspended = true;
        for (T binding : owned) setDown.accept(binding, physicallyDown.test(binding));
    }
    void resume() {
        suspended = false;
        for (T binding : owned) setDown.accept(binding, true);
    }
    void release(T binding) { if (owned.remove(binding)) setDown.accept(binding, physicallyDown.test(binding)); }
    void releaseAll() {
        for (T binding : owned) setDown.accept(binding, physicallyDown.test(binding));
        owned.clear(); suspended = false;
    }
}

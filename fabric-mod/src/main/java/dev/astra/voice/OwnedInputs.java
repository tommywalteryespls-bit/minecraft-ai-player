package dev.astra.voice;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import org.lwjgl.glfw.GLFW;

/** Restores physical state only for keys this mod owns; never calls global releaseAll. */
final class OwnedInputs {
    private final Minecraft client;
    private final InputOwnership<KeyMapping> ownership;
    OwnedInputs(Minecraft client) {
        this.client = client;
        this.ownership = new InputOwnership<>(this::physicallyDown, KeyMapping::setDown);
    }

    boolean physicallyDown(KeyMapping binding) {
        InputConstants.Key key = InputConstants.getKey(binding.saveString());
        if (key.getValue() < 0) return false;
        long window = client.getWindow().handle();
        if (key.getType() == InputConstants.Type.MOUSE) return GLFW.glfwGetMouseButton(window, key.getValue()) == GLFW.GLFW_PRESS;
        if (key.getType() == InputConstants.Type.KEYSYM) return GLFW.glfwGetKey(window, key.getValue()) == GLFW.GLFW_PRESS;
        // Scancode bindings are uncommon; compare physical keys without depending on a keyboard layout.
        for (int code = GLFW.GLFW_KEY_SPACE; code <= GLFW.GLFW_KEY_LAST; code++) {
            if (GLFW.glfwGetKey(window, code) == GLFW.GLFW_PRESS && GLFW.glfwGetKeyScancode(code) == key.getValue()) return true;
        }
        return false;
    }

    boolean manualInput() {
        return physicallyDown(client.options.keyUp) || physicallyDown(client.options.keyDown)
            || physicallyDown(client.options.keyLeft) || physicallyDown(client.options.keyRight)
            || physicallyDown(client.options.keyJump) || physicallyDown(client.options.keyShift)
            || physicallyDown(client.options.keySprint) || physicallyDown(client.options.keyAttack)
            || physicallyDown(client.options.keyUse);
    }

    void hold(KeyMapping binding) { ownership.hold(binding); }
    void suspend() { ownership.suspend(); }
    void resume() { ownership.resume(); }
    void release(KeyMapping binding) { ownership.release(binding); }
    void releaseAll() { ownership.releaseAll(); }
}

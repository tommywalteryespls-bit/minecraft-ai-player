package dev.astra.voice;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import java.net.URI;
import java.util.UUID;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.storage.LevelResource;
import org.lwjgl.glfw.GLFW;
import static net.fabricmc.fabric.api.client.command.v2.ClientCommandManager.literal;

public final class AstraVoiceClient implements ClientModInitializer {
    private final LocalBridge bridge = new LocalBridge();
    private final ManagedBackend backend = new ManagedBackend();
    private final ControlPolicy policy = new ControlPolicy();
    private Minecraft client;
    private OwnedInputs inputs;
    private ActionController controller;
    private BridgeConfig config;
    private KeyMapping toggleKey, panicKey;
    private ClientLevel currentLevel;
    private String sessionId, worldId;
    private int controlEpoch;
    private boolean armed, helloSent, panicWasDown;
    private long nextConnect, nextState;
    private String configStatus = "Not configured";

    @Override public void onInitializeClient() {
        client = Minecraft.getInstance();
        inputs = new OwnedInputs(client);
        controller = new ActionController(client, inputs, policy, this::reply);
        KeyMapping.Category category = KeyMapping.Category.register(Identifier.fromNamespaceAndPath("astra_voice", "controls"));
        toggleKey = KeyBindingHelper.registerKeyBinding(new KeyMapping("key.astra_voice.toggle", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F8, category));
        panicKey = KeyBindingHelper.registerKeyBinding(new KeyMapping("key.astra_voice.panic", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F9, category));
        ClientTickEvents.START_CLIENT_TICK.register(ignored -> tick());
        ClientLifecycleEvents.CLIENT_STOPPING.register(ignored -> { disarm("Minecraft is closing", false); endSession("Minecraft is closing"); bridge.close(); backend.close(); });
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registry) -> dispatcher.register(literal("astra")
            .then(literal("status").executes(context -> { notice(status()); return 1; }))
            .then(literal("connect").executes(context -> { disarm("Reconnecting", false); loadConfig(); nextConnect = 0; return 1; }))
            .then(literal("stop").executes(context -> { disarm("Stopped by player", true); return 1; }))
            .then(literal("voice").executes(context -> { openVoice(); return 1; }))));
        loadConfig();
    }

    private void loadConfig() {
        bridge.close(); helloSent = false; policy.reset();
        try {
            config = BridgeConfig.load(FabricLoader.getInstance().getConfigDir().resolve("astra-voice.json"));
            configStatus = "Configured";
            backend.requestStart(config.backend());
        } catch (Exception error) {
            config = null; configStatus = error.getMessage(); notice(configStatus);
        }
    }

    private void tick() {
        // All state reads, input ownership, mutations and action completion run on this thread.
        try { tickSafely(); }
        catch (RuntimeException error) {
            disarm("Controller stopped after an internal error", true);
            bridge.close(); helloSent = false; policy.reset(); nextConnect = System.nanoTime() + 5_000_000_000L;
        }
    }
    private void tickSafely() {
        boolean panicDown = inputs.physicallyDown(panicKey);
        boolean queuedPanic = false;
        while (panicKey.consumeClick()) queuedPanic = true;
        boolean panicRequested = InputSafety.panicRequested(panicWasDown, panicDown, queuedPanic);
        if (panicRequested) disarm("Emergency stop", true);
        panicWasDown = panicDown;

        if (client.level != currentLevel || (client.player == null && sessionId != null)) {
            disarm("World changed", false); endSession("World changed");
            currentLevel = client.level;
            if (client.level != null && client.player != null) beginSession();
        }
        if (sessionId == null && client.level != null && client.player != null) beginSession();
        if (sessionId == null || client.player == null || client.level == null) return;

        if (bridge.consumeFault() || bridge.heartbeatExpired()) {
            disarm("Voice backend disconnected or heartbeat expired", true);
            bridge.close(); helloSent = false; policy.reset(); nextConnect = System.nanoTime() + 5_000_000_000L;
        }
        long now = System.nanoTime();
        if (!bridge.connected() && !bridge.connecting() && config != null && now >= nextConnect) {
            nextConnect = now + 5_000_000_000L; bridge.connect(config);
        }
        if (bridge.connected() && !helloSent) {
            JsonObject hello = envelope("hello");
            hello.addProperty("protocolVersion", 2); hello.addProperty("username", client.player.getName().getString());
            hello.addProperty("worldId", worldId); hello.addProperty("controlsEnabled", armed); hello.addProperty("controlEpoch", controlEpoch);
            JsonArray supported = new JsonArray(); ActionValidation.SUPPORTED.stream().sorted().forEach(supported::add); hello.add("supportedActions", supported);
            JsonArray capabilities = new JsonArray(); capabilities.add("unrestricted-v1"); capabilities.add("gameplay-skills-v1"); capabilities.add("base-search-v1"); hello.add("capabilities", capabilities);
            bridge.send(hello); helloSent = true; nextState = 0;
        }

        if (armed && (!client.player.isAlive() || client.player.isSpectator())) disarm("Death or spectator mode", true);
        if (armed && !policy.unrestricted() && ((client.screen != null && !controller.ownsScreen()) || !client.isWindowActive())) disarm("Menu or focus loss", true);
        if (armed && !policy.unrestricted() && (inputs.manualInput() || controller.mouseOverride())) disarm("Manual input took control", true);
        while (toggleKey.consumeClick()) {
            if (armed) disarm("Voice controls disabled", true);
            else if (!panicRequested && !panicDown && client.screen == null && client.isWindowActive() && client.player.isAlive() && !client.player.isSpectator() && helloSent && bridge.connected() && !inputs.manualInput()) {
                armed = true; controlEpoch++; sendControl("Enabled by F8");
                notice(policy.unrestricted() ? "Voice control ARMED, UNRESTRICTED. F9 stops; manual input and focus loss do not. Menus pause game actions."
                    : "Voice control ARMED. F9 stops immediately; manual movement or menus disarm it.");
            } else notice("Cannot arm yet. Close menus, release movement keys, and connect the local backend. /astra status");
        }

        JsonObject message; int processed = 0;
        while (processed++ < 8 && (message = bridge.poll()) != null) handle(message);
        if (armed) controller.tick();
        if (now >= nextState && bridge.connected() && helloSent) {
            nextState = now + 500_000_000L;
            JsonObject state = envelope("state"); state.addProperty("controlEpoch", controlEpoch); state.addProperty("controlsEnabled", armed);
            state.add("state", WorldSnapshot.capture(client, controller.actionState())); bridge.send(state);
        }
    }

    private void beginSession() {
        sessionId = UUID.randomUUID().toString(); controlEpoch = 0; armed = false; helloSent = false; policy.reset();
        if (client.getSingleplayerServer() != null) worldId = "singleplayer:" + client.getSingleplayerServer().getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize();
        else if (client.getCurrentServer() != null) worldId = "multiplayer:" + client.getCurrentServer().ip.toLowerCase(java.util.Locale.ROOT);
        else worldId = "unknown-world:" + sessionId; // No accidental memory sharing when identity cannot be established.
        nextConnect = 0; notice("Astra voice ready but DISARMED. /astra voice opens the microphone panel; F8 arms, F9 stops.");
    }
    private void endSession(String reason) {
        if (sessionId != null && helloSent) { JsonObject message = envelope("session_end"); message.addProperty("reason", reason); bridge.send(message); }
        sessionId = null; worldId = null; helloSent = false; policy.reset();
    }
    private void handle(JsonObject message) {
        String type;
        try { type = ActionValidation.string(message, "type", "", 32); }
        catch (RuntimeException error) { disarm("Invalid bridge message", true); return; }
        if (type.equals("welcome")) {
            policy.welcome(sessionId, message);
            return;
        }
        if (type.equals("cancel")) {
            if (sessionId.equals(ActionValidation.string(message, "sessionId", "", 64))) controller.cancel(ActionValidation.string(message, "requestId", null, 64), "Cancelled by voice backend");
            return;
        }
        if (!type.equals("action")) return;
        try {
            String id = ActionValidation.string(message, "requestId", "", 64);
            if (!id.matches("[A-Za-z0-9_-]{1,64}")) throw new IllegalArgumentException("Invalid request ID");
            if (!ActionValidation.accepts(sessionId, controlEpoch, armed, message)) throw new IllegalArgumentException("Action rejected: disarmed, unsupported, or stale world/control session");
            controller.start(message);
        } catch (RuntimeException error) {
            controller.reject(message, error.getMessage() == null ? "Invalid action" : error.getMessage());
        }
    }
    private void reply(JsonObject request, JsonObject result) {
        if (client.player != null && client.level != null && sessionId != null && helloSent) {
            JsonObject state = envelope("state"); state.addProperty("controlEpoch", controlEpoch); state.addProperty("controlsEnabled", armed);
            state.add("state", WorldSnapshot.capture(client, controller.actionState())); bridge.send(state);
        }
        JsonObject message = new JsonObject(); message.addProperty("type", "result");
        if (!request.has("requestId") || !request.has("sessionId")) return;
        message.add("requestId", request.get("requestId")); message.add("sessionId", request.get("sessionId")); message.add("result", result);
        bridge.send(message);
    }
    private void disarm(String reason, boolean notify) {
        boolean hadControl = armed || controller.active();
        armed = false; controller.cancel(reason); controlEpoch++;
        if (sessionId != null && helloSent) sendControl(reason);
        if (notify && hadControl) notice(reason + ". Press F8 when ready to re-arm.");
    }
    private void sendControl(String reason) {
        JsonObject control = envelope("control"); control.addProperty("controlEpoch", controlEpoch); control.addProperty("enabled", armed); control.addProperty("reason", reason); bridge.send(control);
        nextState = 0;
    }
    private JsonObject envelope(String type) { JsonObject data = new JsonObject(); data.addProperty("type", type); if (sessionId != null) data.addProperty("sessionId", sessionId); return data; }
    private String status() { return "Astra: " + (armed ? "ARMED" : "DISARMED") + "; " + (policy.unrestricted() ? "UNRESTRICTED" : "bounded") + "; " + (config == null ? configStatus : bridge.status() + "; " + backend.status()) + "; " + (sessionId == null ? "no world" : "world connected"); }
    private void notice(String message) { if (client.player != null) client.player.displayClientMessage(Component.literal(message), false); }
    private void openVoice() {
        if (config == null) { notice(configStatus); return; }
        if (!policy.unrestricted()) disarm("Opening voice panel", false);
        net.minecraft.util.Util.getPlatform().openUri(URI.create("http://127.0.0.1:" + config.voicePort() + "/"));
        notice("Start hands-free in the browser, then return to Minecraft, close menus, and press F8.");
    }
}

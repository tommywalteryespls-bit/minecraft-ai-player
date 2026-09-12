package dev.astra.voice;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/** Contains only a local pairing token, never an OpenAI API key. */
public record BridgeConfig(int bridgePort, int voicePort, String token, Backend backend) {
    public BridgeConfig(int bridgePort, int voicePort, String token) { this(bridgePort, voicePort, token, Backend.manual()); }
    public BridgeConfig { if (backend == null) backend = Backend.manual(); }

    /** Optional installer-owned launch settings. A bad launch setting must not break manual pairing. */
    public record Backend(boolean autoStart, String projectDirectory, String nodeExecutable, String error) {
        public Backend(boolean autoStart, String projectDirectory, String nodeExecutable) { this(autoStart, projectDirectory, nodeExecutable, null); }
        static Backend manual() { return new Backend(false, null, null); }
        static Backend invalid() { return new Backend(false, null, null, "Invalid backend auto-start settings. Run the project installer again, or start the backend manually."); }
        static Backend read(JsonElement element) {
            if (element == null || element.isJsonNull()) return manual();
            try {
                if (!element.isJsonObject()) return invalid();
                JsonObject object = element.getAsJsonObject();
                JsonElement enabled = object.get("autoStart");
                if (enabled == null || !enabled.isJsonPrimitive() || !enabled.getAsJsonPrimitive().isBoolean()) return invalid();
                if (!enabled.getAsBoolean()) return manual();
                String project = string(object.get("projectDirectory")), node = string(object.get("nodeExecutable"));
                if (project == null || node == null) return invalid();
                return new Backend(true, project, node);
            } catch (RuntimeException error) { return invalid(); }
        }
        private static String string(JsonElement value) {
            if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) return null;
            String text = value.getAsString();
            return text.isBlank() || text.length() > 2048 || text.chars().anyMatch(character -> character < 32) ? null : text;
        }
    }

    public static BridgeConfig load(Path file) throws IOException {
        if (!Files.isRegularFile(file)) throw new IOException("Missing config/astra-voice.json. Run the project installer first.");
        if (Files.size(file) > 4096) throw new IOException("Voice config is too large.");
        try {
            JsonObject object = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            Backend backend = Backend.read(object.remove("backend"));
            BridgeConfig config = new Gson().fromJson(object, BridgeConfig.class);
            if (config == null || config.bridgePort < 1024 || config.bridgePort > 65535
                || config.voicePort < 1024 || config.voicePort > 65535
                || config.token == null || !config.token.matches("[a-fA-F0-9]{64}")) {
                throw new IOException("Voice config needs valid ports and a 64-character hexadecimal pairing token.");
            }
            return new BridgeConfig(config.bridgePort, config.voicePort, config.token, backend);
        } catch (RuntimeException error) {
            throw new IOException("Invalid config/astra-voice.json", error);
        }
    }
}

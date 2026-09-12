package dev.astra.voice;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class BridgeConfigTest {
    @TempDir Path directory;
    @Test void validConfigurationIsLoadedWithoutAnApiKey() throws Exception {
        Path config = directory.resolve("astra-voice.json");
        Files.writeString(config, "{\"bridgePort\":8765,\"voicePort\":3001,\"token\":\"" + "a".repeat(64) + "\"}");
        BridgeConfig loaded = BridgeConfig.load(config);
        assertEquals(8765, loaded.bridgePort()); assertEquals(3001, loaded.voicePort()); assertEquals("a".repeat(64), loaded.token());
        assertFalse(loaded.backend().autoStart()); assertNull(loaded.backend().error());
    }
    @Test void invalidPortAndTokenAreRejected() throws Exception {
        Path config = directory.resolve("astra-voice.json");
        for (String data : new String[] {"{}", "null", "not json", "{\"bridgePort\":80,\"voicePort\":3001,\"token\":\"" + "a".repeat(64) + "\"}", "{\"bridgePort\":8765,\"voicePort\":3001,\"token\":\"not-a-token\"}"}) {
            Files.writeString(config, data); assertThrows(IOException.class, () -> BridgeConfig.load(config));
        }
    }
    @Test void missingAndOversizeConfigurationAreRejected() throws Exception {
        assertThrows(IOException.class, () -> BridgeConfig.load(directory.resolve("missing.json")));
        Path config = directory.resolve("astra-voice.json"); Files.writeString(config, "x".repeat(4097));
        assertThrows(IOException.class, () -> BridgeConfig.load(config));
    }
    @Test void installerBackendSettingsAreReadWithoutExposingTheApiKey() throws Exception {
        JsonObject backend = new JsonObject(); backend.addProperty("autoStart", true);
        backend.addProperty("projectDirectory", directory.toString()); backend.addProperty("nodeExecutable", directory.resolve("node.exe").toString());
        BridgeConfig loaded = withBackend(backend.toString());
        assertTrue(loaded.backend().autoStart()); assertEquals(directory.toString(), loaded.backend().projectDirectory());
        assertEquals(directory.resolve("node.exe").toString(), loaded.backend().nodeExecutable()); assertNull(loaded.backend().error());
    }
    @Test void malformedOptionalBackendDisablesAutostartButDoesNotBreakManualConnection() throws Exception {
        for (String backend : new String[] {"[]", "true", "\"bad\"", "{}", "{\"autoStart\":\"true\"}",
            "{\"autoStart\":true,\"projectDirectory\":4,\"nodeExecutable\":\"node\"}",
            "{\"autoStart\":true,\"projectDirectory\":\"path\",\"nodeExecutable\":\"\"}"}) {
            BridgeConfig loaded = withBackend(backend);
            assertEquals(8765, loaded.bridgePort()); assertEquals("a".repeat(64), loaded.token());
            assertFalse(loaded.backend().autoStart()); assertNotNull(loaded.backend().error());
        }
        for (String backend : new String[] {"null", "{\"autoStart\":false}"}) {
            BridgeConfig loaded = withBackend(backend); assertFalse(loaded.backend().autoStart()); assertNull(loaded.backend().error());
        }
    }
    private BridgeConfig withBackend(String backend) throws Exception {
        Path config = directory.resolve("astra-voice.json");
        Files.writeString(config, "{\"bridgePort\":8765,\"voicePort\":3001,\"token\":\"" + "a".repeat(64) + "\",\"backend\":" + backend + "}");
        return BridgeConfig.load(config);
    }
}

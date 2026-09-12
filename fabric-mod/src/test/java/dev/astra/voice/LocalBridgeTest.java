package dev.astra.voice;

import com.google.gson.JsonObject;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Base64;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class LocalBridgeTest {
    private static final String TOKEN = "a".repeat(64);
    @Test void connectsOnlyToLocalAuthenticatedPathAndReceivesMessages() throws Exception {
        try (TestServer server = new TestServer()) {
            LocalBridge bridge = new LocalBridge();
            try {
                bridge.connect(new BridgeConfig(server.port(), 3001, TOKEN));
                server.open(); await(bridge::connected);
                assertTrue(server.headers.contains("GET /astra HTTP/1.1"));
                assertTrue(server.headers.toLowerCase().contains("authorization: bearer " + TOKEN));
                server.text("{\"type\":\"heartbeat\"}");
                server.text("{\"type\":\"welcome\",\"protocolVersion\":2}");
                CompletableFuture<JsonObject> message = CompletableFuture.supplyAsync(() -> {
                    JsonObject value;
                    long until = System.nanoTime() + 2_000_000_000L;
                    while (System.nanoTime() < until) {
                        if ((value = bridge.poll()) != null) return value;
                        try { Thread.sleep(5); } catch (InterruptedException error) { throw new RuntimeException(error); }
                    }
                    throw new AssertionError("No bridge message arrived");
                });
                assertEquals("welcome", message.get(3, TimeUnit.SECONDS).get("type").getAsString());
                assertFalse(bridge.heartbeatExpired());
                JsonObject outgoing = new JsonObject(); outgoing.addProperty("type", "hello"); bridge.send(outgoing);
                assertTrue(server.readFrame().contains("\"type\":\"hello\""));
                bridge.close(); assertFalse(bridge.connected()); assertNull(bridge.poll());
            } finally { bridge.close(); }
        }
    }
    @Test void malformedOrOversizedMessagesDisconnectSafely() throws Exception {
        for (String data : new String[] {"this is not JSON", "x".repeat(65537)}) {
            try (TestServer server = new TestServer()) {
                LocalBridge bridge = new LocalBridge();
                try {
                    bridge.connect(new BridgeConfig(server.port(), 3001, TOKEN)); server.open(); await(bridge::connected);
                    server.text(data); await(() -> !bridge.connected()); assertTrue(bridge.consumeFault()); assertFalse(bridge.consumeFault());
                } finally { bridge.close(); }
            }
        }
    }
    @Test void inboxIsBoundedAndOverflowDisarmsTransport() throws Exception {
        try (TestServer server = new TestServer()) {
            LocalBridge bridge = new LocalBridge();
            try {
                bridge.connect(new BridgeConfig(server.port(), 3001, TOKEN)); server.open(); await(bridge::connected);
                for (int i = 0; i < 33; i++) server.text("{\"type\":\"welcome\"}");
                await(() -> !bridge.connected()); assertTrue(bridge.consumeFault());
            } finally { bridge.close(); }
        }
    }
    @Test void absentHeartbeatsAreDetectedWithinTheSafetyDeadline() throws Exception {
        try (TestServer server = new TestServer()) {
            LocalBridge bridge = new LocalBridge();
            try {
                bridge.connect(new BridgeConfig(server.port(), 3001, TOKEN)); server.open(); await(bridge::connected);
                assertFalse(bridge.heartbeatExpired());
                Thread.sleep(3100);
                assertTrue(bridge.heartbeatExpired());
                bridge.close(); assertFalse(bridge.heartbeatExpired());
            } finally { bridge.close(); }
        }
    }
    private static void await(BooleanSupplier condition) throws InterruptedException {
        long until = System.nanoTime() + Duration.ofSeconds(3).toNanos();
        while (!condition.getAsBoolean() && System.nanoTime() < until) Thread.sleep(5);
        assertTrue(condition.getAsBoolean(), "Timed out waiting for local bridge state");
    }
    private static final class TestServer implements AutoCloseable {
        final ServerSocket listener;
        Socket socket;
        String headers;
        TestServer() throws Exception { listener = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")); listener.setSoTimeout(3000); }
        int port() { return listener.getLocalPort(); }
        void open() throws Exception {
            socket = listener.accept(); socket.setSoTimeout(3000);
            StringBuilder raw = new StringBuilder(); InputStream input = socket.getInputStream();
            while (!raw.toString().endsWith("\r\n\r\n")) {
                int value = input.read(); if (value < 0 || raw.length() > 8192) throw new AssertionError("Bad handshake"); raw.append((char)value);
            }
            headers = raw.toString();
            String key = headers.lines().filter(line -> line.toLowerCase().startsWith("sec-websocket-key:")).findFirst().orElseThrow().split(":", 2)[1].trim();
            String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
            socket.getOutputStream().write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().flush();
        }
        void text(String text) throws Exception {
            byte[] data = text.getBytes(StandardCharsets.UTF_8); OutputStream output = socket.getOutputStream(); output.write(0x81);
            if (data.length < 126) output.write(data.length);
            else if (data.length <= 65535) { output.write(126); output.write(data.length >>> 8); output.write(data.length); }
            else { output.write(127); for (int shift = 56; shift >= 0; shift -= 8) output.write((int)((long)data.length >>> shift)); }
            output.write(data); output.flush();
        }
        String readFrame() throws Exception {
            InputStream input = socket.getInputStream(); assertEquals(0x81, input.read()); int length = input.read(); assertTrue((length & 0x80) != 0); length &= 0x7f;
            if (length == 126) length = (input.read() << 8) | input.read();
            assertTrue(length < 1260); byte[] mask = input.readNBytes(4), data = input.readNBytes(length);
            for (int index = 0; index < data.length; index++) data[index] ^= mask[index % 4];
            return new String(data, StandardCharsets.UTF_8);
        }
        @Override public void close() throws Exception { if (socket != null) socket.close(); listener.close(); }
    }
}

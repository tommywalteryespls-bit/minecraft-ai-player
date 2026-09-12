package dev.astra.voice;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

/** Networking never reads or changes Minecraft state. The tick thread drains the bounded inbox. */
public final class LocalBridge {
    private final ArrayBlockingQueue<JsonObject> incoming = new ArrayBlockingQueue<>(32);
    private volatile WebSocket socket;
    private volatile long lastHeartbeat;
    private volatile String status = "Not connected";
    private volatile boolean connecting;
    private volatile int generation;
    private final AtomicBoolean fault = new AtomicBoolean();
    private CompletableFuture<WebSocket> outbound = CompletableFuture.completedFuture(null);
    private int queuedSends;

    public synchronized void connect(BridgeConfig config) {
        close();
        connecting = true;
        int expected = generation;
        status = "Connecting to local voice backend";
        try {
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build().newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(3)).header("Authorization", "Bearer " + config.token())
                .buildAsync(URI.create("ws://127.0.0.1:" + config.bridgePort() + "/astra"), new WebSocket.Listener() {
                    private final StringBuilder partial = new StringBuilder();
                    @Override public void onOpen(WebSocket webSocket) {
                        synchronized (LocalBridge.this) {
                            if (expected != generation) { webSocket.abort(); return; }
                            socket = webSocket;
                            connecting = false;
                            lastHeartbeat = System.nanoTime();
                            status = "Connected to local voice backend";
                        }
                        webSocket.request(1);
                    }
                    @Override public CompletionStage<?> onText(WebSocket webSocket, CharSequence text, boolean last) {
                        if (expected != generation) return null;
                        if (partial.length() + text.length() > 65536) { fail("Bridge message too large"); return null; }
                        partial.append(text);
                        if (last) {
                            try {
                                JsonObject message = JsonParser.parseString(partial.toString()).getAsJsonObject();
                                if ("heartbeat".equals(ActionValidation.string(message, "type", "", 32))) lastHeartbeat = System.nanoTime();
                                else if (!incoming.offer(message)) fail("Bridge queue overflow");
                            } catch (RuntimeException error) { fail("Malformed bridge message"); }
                            partial.setLength(0);
                        }
                        webSocket.request(1);
                        return null;
                    }
                    @Override public CompletionStage<?> onClose(WebSocket webSocket, int code, String reason) {
                        if (expected == generation) fail("Local voice backend disconnected");
                        return null;
                    }
                    @Override public void onError(WebSocket webSocket, Throwable error) {
                        if (expected == generation) fail("Local voice backend connection failed");
                    }
                }).exceptionally(error -> { if (expected == generation) fail("Voice backend not connected yet. Check /astra status; /astra connect retries startup"); return null; });
        } catch (RuntimeException error) { fail("Could not initialize local voice networking"); }
    }

    private synchronized void fail(String reason) {
        status = reason;
        connecting = false;
        fault.set(true);
        if (socket != null) socket.abort();
        socket = null;
    }

    public synchronized void close() {
        generation++;
        if (socket != null) socket.abort();
        socket = null;
        connecting = false;
        incoming.clear();
        outbound = CompletableFuture.completedFuture(null);
        queuedSends = 0;
        fault.set(false);
    }

    public synchronized void send(JsonObject message) {
        WebSocket target = socket;
        if (target == null) return;
        if (queuedSends >= 8) { fail("Local voice backend stopped reading"); return; }
        int expected = generation;
        queuedSends++;
        outbound = outbound.handle((ignored, error) -> target).thenCompose(ws -> ws.sendText(message.toString(), true))
            .whenComplete((ignored, error) -> {
                synchronized (LocalBridge.this) {
                    if (generation != expected) return;
                    queuedSends--;
                    if (error != null) fail("Could not send to local voice backend");
                }
            });
    }

    public JsonObject poll() { return incoming.poll(); }
    public boolean connected() { return socket != null; }
    public boolean connecting() { return connecting; }
    public String status() { return status; }
    public boolean consumeFault() { return fault.getAndSet(false); }
    public boolean heartbeatExpired() { return connected() && System.nanoTime() - lastHeartbeat > 3_000_000_000L; }
}

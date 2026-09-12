package dev.astra.voice;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Owns only the child it launches; all filesystem, launch and shutdown work stays off the game thread. */
public final class ManagedBackend implements AutoCloseable {
    record LaunchSpec(Path node, Path script, Path project, Path log) {}
    @FunctionalInterface interface ProcessFactory { Process start(LaunchSpec spec) throws IOException; }

    private final ExecutorService worker = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "Astra backend lifecycle"); thread.setDaemon(true); return thread;
    });
    private final ProcessFactory factory;
    private final Duration grace;
    private final CompletableFuture<Void> stopped = new CompletableFuture<>();
    private volatile String status = "Backend auto-start not configured (manual startup)";
    private Process owned;
    private boolean starting, closed;

    public ManagedBackend() {
        this(spec -> builder(spec).start(), Duration.ofSeconds(16));
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            close();
            try { stopped.get(20, TimeUnit.SECONDS); }
            catch (Exception ignored) { /* JVM exit closes the owned child's stdin as a final fallback. */ }
        }, "Astra backend shutdown"));
    }
    ManagedBackend(ProcessFactory factory, Duration grace) { this.factory = factory; this.grace = grace; }

    /** Called once at init, or deliberately by /astra connect. Never restarts automatically after failure. */
    public synchronized void requestStart(BridgeConfig.Backend config) {
        if (closed || starting || (owned != null && owned.isAlive())) return;
        if (config == null || !config.autoStart()) {
            status = config != null && config.error() != null ? config.error() : "Backend auto-start disabled (manual startup)";
            return;
        }
        starting = true;
        status = "Starting local voice backend in the background";
        worker.execute(() -> launch(config));
    }

    private void launch(BridgeConfig.Backend config) {
        try {
            LaunchSpec spec = validate(config);
            synchronized (this) { if (closed) return; }
            Process child = factory.start(spec);
            synchronized (this) {
                owned = child;
                if (!closed) status = "Background backend started (see bridge connection status)";
            }
            child.onExit().thenAccept(exited -> {
                synchronized (ManagedBackend.this) {
                    if (owned != exited) return;
                    owned = null;
                    if (!closed) status = exited.exitValue() == 0
                        ? "Backend launcher finished normally (possibly reused an existing backend); see bridge connection status"
                        : "Background backend exited with code " + exited.exitValue() + ". Check logs/fabric-backend.log; /astra connect retries.";
                }
            });
        } catch (LaunchFailure error) {
            synchronized (this) { if (!closed) status = error.getMessage(); }
        } catch (IOException | RuntimeException error) {
            // Exception messages can contain command/environment data. Do not echo them into game chat.
            synchronized (this) { if (!closed) status = "Could not launch the background backend. Check Node/project access and logs/fabric-backend.log; /astra connect retries."; }
        } finally { synchronized (this) { starting = false; } }
    }

    static LaunchSpec validate(BridgeConfig.Backend config) throws IOException {
        Path project = localAbsolute(config.projectDirectory(), "Project directory");
        Path node = localAbsolute(config.nodeExecutable(), "Node executable");
        if (!Files.isDirectory(project)) throw new LaunchFailure("Backend project directory is missing. Run the project installer again.");
        if (!Files.isRegularFile(node)) throw new LaunchFailure("Backend Node executable is missing. Run the project installer again.");
        project = localAbsolute(project.toRealPath().toString(), "Project directory");
        node = localAbsolute(node.toRealPath().toString(), "Node executable");
        String name = node.getFileName().toString().toLowerCase(Locale.ROOT);
        if (!name.equals("node.exe") && !name.equals("node")) throw new LaunchFailure("Backend executable must be Node itself, not a shell or command script. Run the project installer again.");
        Path script = project.resolve("scripts/start-fabric-managed.mjs");
        if (!Files.isRegularFile(script) || !script.toRealPath().startsWith(project))
            throw new LaunchFailure("Managed backend launcher is missing or outside the project. Run the project installer again.");
        Path logs = project.resolve("logs");
        Files.createDirectories(logs);
        if (!logs.toRealPath().startsWith(project)) throw new LaunchFailure("Backend logs directory must stay inside the project.");
        Path log = logs.resolve("fabric-backend.log");
        if (Files.isSymbolicLink(log) || (Files.exists(log, LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(log, LinkOption.NOFOLLOW_LINKS)))
            throw new LaunchFailure("Backend log must be a regular file inside the project.");
        return new LaunchSpec(node, script.toRealPath(), project, log);
    }

    private static Path localAbsolute(String text, String label) throws LaunchFailure {
        if (text == null || text.isBlank() || text.startsWith("\\\\") || text.startsWith("//") || text.chars().anyMatch(character -> character < 32))
            throw new LaunchFailure(label + " must be an absolute local path. Run the project installer again.");
        try {
            Path path = Path.of(text);
            if (!path.isAbsolute()) throw new LaunchFailure(label + " must be an absolute local path. Run the project installer again.");
            return path.normalize();
        } catch (java.nio.file.InvalidPathException error) { throw new LaunchFailure(label + " is invalid. Run the project installer again."); }
    }

    static ProcessBuilder builder(LaunchSpec spec) {
        // Never invoke cmd/PowerShell, inherit a terminal, or put the API key/pairing token on the command line.
        return new ProcessBuilder(spec.node().toString(), spec.script().toString())
            .directory(spec.project().toFile()).redirectInput(ProcessBuilder.Redirect.PIPE)
            .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(spec.log().toFile()));
    }

    public String status() { return status; }
    CompletableFuture<Void> whenStopped() { return stopped; }

    /** Nonblocking for CLIENT_STOPPING; the worker closes stdin and waits only for its own child. */
    @Override public synchronized void close() {
        if (closed) return;
        closed = true; status = "Stopping Minecraft-owned voice backend";
        worker.execute(() -> {
            try {
                Process child;
                synchronized (this) { child = owned; }
                if (child != null) stopOwned(child);
            } finally {
                synchronized (this) { owned = null; status = "Minecraft-owned backend stopped"; }
                stopped.complete(null); worker.shutdown();
            }
        });
    }

    private void stopOwned(Process child) {
        try { child.getOutputStream().close(); } catch (IOException ignored) {}
        try {
            if (!child.waitFor(grace.toMillis(), TimeUnit.MILLISECONDS)) {
                child.destroy();
                if (!child.waitFor(1000, TimeUnit.MILLISECONDS)) {
                    child.destroyForcibly(); child.waitFor(1000, TimeUnit.MILLISECONDS);
                }
            }
        } catch (InterruptedException error) { child.destroyForcibly(); Thread.currentThread().interrupt(); }
    }

    private static final class LaunchFailure extends IOException { LaunchFailure(String message) { super(message); } }
}

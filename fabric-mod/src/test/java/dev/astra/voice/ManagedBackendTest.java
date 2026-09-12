package dev.astra.voice;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class ManagedBackendTest {
    @TempDir Path directory;

    @Test void launchesNodeDirectlyWithoutShellOrTerminalAndClosesOnlyItsOwnedStdin() throws Exception {
        BridgeConfig.Backend config = installed();
        AtomicReference<ManagedBackend.LaunchSpec> captured = new AtomicReference<>(); FakeProcess child = new FakeProcess(true, false);
        ManagedBackend manager = manager(spec -> { captured.set(spec); return child; });
        try {
            manager.requestStart(config); await(() -> captured.get() != null && manager.status().contains("started"));
            ManagedBackend.LaunchSpec spec = captured.get(); ProcessBuilder builder = ManagedBackend.builder(spec);
            assertEquals(List.of(Path.of(config.nodeExecutable()).toRealPath().toString(), directory.resolve("project with spaces/scripts/start-fabric-managed.mjs").toRealPath().toString()), builder.command());
            assertEquals(spec.project().toFile(), builder.directory()); assertEquals(ProcessBuilder.Redirect.PIPE, builder.redirectInput());
            assertTrue(builder.redirectErrorStream()); assertEquals(ProcessBuilder.Redirect.Type.APPEND, builder.redirectOutput().type());
            assertEquals(spec.project().resolve("logs/fabric-backend.log").toFile(), builder.redirectOutput().file());
            assertFalse(child.stdinClosed); assertTrue(child.isAlive());
        } finally { stop(manager); }
        assertTrue(child.stdinClosed); assertEquals(0, child.destroyCalls); assertEquals(0, child.forceCalls); assertFalse(child.isAlive());
    }

    @Test void disabledLegacyAndMalformedOptionalSettingsNeverLaunch() throws Exception {
        AtomicInteger calls = new AtomicInteger(); ManagedBackend manager = manager(spec -> { calls.incrementAndGet(); return new FakeProcess(true, false); });
        try {
            manager.requestStart(new BridgeConfig(8765, 3001, "a".repeat(64)).backend());
            assertTrue(manager.status().contains("disabled"));
            manager.requestStart(BridgeConfig.Backend.invalid()); assertTrue(manager.status().contains("Invalid backend"));
        } finally { stop(manager); }
        assertEquals(0, calls.get());
    }

    @Test void rejectsMissingRelativeNetworkOrNonNodePathsBeforeLaunching() throws Exception {
        BridgeConfig.Backend valid = installed();
        assertThrows(IOException.class, () -> ManagedBackend.validate(new BridgeConfig.Backend(true, "relative", valid.nodeExecutable())));
        assertThrows(IOException.class, () -> ManagedBackend.validate(new BridgeConfig.Backend(true, "\\\\server\\share", valid.nodeExecutable())));
        assertThrows(IOException.class, () -> ManagedBackend.validate(new BridgeConfig.Backend(true, valid.projectDirectory(), "//server/node.exe")));
        assertThrows(IOException.class, () -> ManagedBackend.validate(new BridgeConfig.Backend(true, directory.resolve("missing").toString(), valid.nodeExecutable())));
        assertThrows(IOException.class, () -> ManagedBackend.validate(new BridgeConfig.Backend(true, valid.projectDirectory(), directory.resolve("missing.exe").toString())));
        Path shell = directory.resolve("cmd.exe"); Files.createFile(shell);
        assertThrows(IOException.class, () -> ManagedBackend.validate(new BridgeConfig.Backend(true, valid.projectDirectory(), shell.toString())));
        Path launcher = Path.of(valid.projectDirectory()).resolve("scripts/start-fabric-managed.mjs"); Files.delete(launcher);
        assertThrows(IOException.class, () -> ManagedBackend.validate(valid));
    }

    @Test void repeatedConnectDoesNotSpawnDuplicatesOrReplaceAnOwnedProcess() throws Exception {
        BridgeConfig.Backend config = installed(); FakeProcess child = new FakeProcess(true, false); AtomicInteger calls = new AtomicInteger();
        ManagedBackend manager = manager(spec -> { calls.incrementAndGet(); return child; });
        try {
            for (int index = 0; index < 10; index++) manager.requestStart(config);
            await(() -> manager.status().contains("started"));
            manager.requestStart(new BridgeConfig.Backend(true, "changed invalid path", "node"));
            manager.requestStart(BridgeConfig.Backend.manual());
            assertEquals(1, calls.get()); assertTrue(manager.status().contains("started")); assertTrue(child.isAlive());
        } finally { stop(manager); }
    }

    @Test void nonzeroExitIsReportedWithoutAutomaticRestartAndExplicitConnectCanRetry() throws Exception {
        BridgeConfig.Backend config = installed(); FakeProcess first = new FakeProcess(true, false), second = new FakeProcess(true, false);
        AtomicInteger calls = new AtomicInteger(); ManagedBackend manager = manager(spec -> calls.incrementAndGet() == 1 ? first : second);
        try {
            manager.requestStart(config); await(() -> manager.status().contains("started")); first.finish(7);
            await(() -> manager.status().contains("code 7")); assertEquals(1, calls.get());
            manager.requestStart(config); await(() -> calls.get() == 2 && manager.status().contains("started"));
        } finally { stop(manager); }
        assertFalse(first.stdinClosed); assertTrue(second.stdinClosed);
    }

    @Test void cleanReuseExitDoesNotGrantOwnershipOfTheExistingBackend() throws Exception {
        BridgeConfig.Backend config = installed(); FakeProcess probe = new FakeProcess(true, false);
        ManagedBackend manager = manager(spec -> probe);
        try {
            manager.requestStart(config); await(() -> manager.status().contains("started")); probe.finish(0);
            await(() -> manager.status().contains("possibly reused an existing backend"));
        } finally { stop(manager); }
        assertFalse(probe.stdinClosed); assertEquals(0, probe.destroyCalls); assertEquals(0, probe.forceCalls);
    }

    @Test void closeIsNonblockingDuringStartupAndLateChildIsStillStopped() throws Exception {
        BridgeConfig.Backend config = installed(); FakeProcess child = new FakeProcess(true, false);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        ManagedBackend manager = manager(spec -> {
            entered.countDown(); try { if (!release.await(3, TimeUnit.SECONDS)) throw new IOException("Test release timed out"); }
            catch (InterruptedException error) { throw new IOException(error); } return child;
        });
        try {
            manager.requestStart(config); assertTrue(entered.await(3, TimeUnit.SECONDS));
            long before = System.nanoTime(); manager.close(); assertTrue(System.nanoTime() - before < Duration.ofMillis(250).toNanos());
            assertFalse(manager.whenStopped().isDone()); release.countDown(); manager.whenStopped().get(3, TimeUnit.SECONDS);
            assertTrue(child.stdinClosed); assertFalse(child.isAlive());
            manager.requestStart(config); assertTrue(manager.status().contains("stopped"));
        } finally { release.countDown(); stop(manager); }
    }

    @Test void aStubbornOwnedChildIsTerminatedAfterBoundedGrace() throws Exception {
        BridgeConfig.Backend config = installed(); FakeProcess child = new FakeProcess(false, true); ManagedBackend manager = manager(spec -> child);
        manager.requestStart(config); await(() -> manager.status().contains("started")); stop(manager);
        assertTrue(child.stdinClosed); assertEquals(1, child.destroyCalls); assertEquals(1, child.forceCalls); assertFalse(child.isAlive());
    }

    @Test void launchFailuresDoNotEchoExceptionSecretsAndCanBeRetried() throws Exception {
        BridgeConfig.Backend config = installed(); AtomicInteger calls = new AtomicInteger(); ManagedBackend manager = manager(spec -> { calls.incrementAndGet(); throw new IOException("secret-value-that-must-not-appear"); });
        try {
            manager.requestStart(config); await(() -> manager.status().contains("Could not launch"));
            assertFalse(manager.status().contains("secret-value")); assertEquals(1, calls.get());
            manager.requestStart(config); await(() -> calls.get() == 2 && manager.status().contains("Could not launch"));
        } finally { stop(manager); }
    }

    private BridgeConfig.Backend installed() throws IOException {
        Path project = directory.resolve("project with spaces"); Files.createDirectories(project.resolve("scripts"));
        Files.writeString(project.resolve("scripts/start-fabric-managed.mjs"), "// Test fixture; never executed\n");
        Path node = directory.resolve("node.exe"); Files.writeString(node, "Test fixture; never executed");
        return new BridgeConfig.Backend(true, project.toString(), node.toString());
    }
    private static ManagedBackend manager(ManagedBackend.ProcessFactory factory) { return new ManagedBackend(factory, Duration.ofMillis(20)); }
    private static void stop(ManagedBackend manager) throws Exception { manager.close(); manager.whenStopped().get(4, TimeUnit.SECONDS); }
    private static void await(BooleanSupplier condition) throws InterruptedException {
        long until = System.nanoTime() + Duration.ofSeconds(3).toNanos();
        while (!condition.getAsBoolean() && System.nanoTime() < until) Thread.sleep(5);
        assertTrue(condition.getAsBoolean(), "Timed out waiting for managed backend state");
    }

    private static final class FakeProcess extends Process {
        final CompletableFuture<Process> exit = new CompletableFuture<>();
        final boolean graceful, stubborn;
        volatile boolean stdinClosed; volatile int destroyCalls, forceCalls, code;
        FakeProcess(boolean graceful, boolean stubborn) { this.graceful = graceful; this.stubborn = stubborn; }
        void finish(int code) { this.code = code; exit.complete(this); }
        @Override public OutputStream getOutputStream() { return new OutputStream() {
            @Override public void write(int value) {}
            @Override public void close() { stdinClosed = true; if (graceful) finish(0); }
        }; }
        @Override public InputStream getInputStream() { return InputStream.nullInputStream(); }
        @Override public InputStream getErrorStream() { return InputStream.nullInputStream(); }
        @Override public int waitFor() throws InterruptedException { try { exit.get(); } catch (java.util.concurrent.ExecutionException error) { throw new AssertionError(error); } return code; }
        @Override public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
            try { exit.get(timeout, unit); return true; }
            catch (TimeoutException error) { return false; }
            catch (java.util.concurrent.ExecutionException error) { throw new AssertionError(error); }
        }
        @Override public int exitValue() { if (!exit.isDone()) throw new IllegalThreadStateException(); return code; }
        @Override public boolean isAlive() { return !exit.isDone(); }
        @Override public void destroy() { destroyCalls++; if (!stubborn) finish(143); }
        @Override public Process destroyForcibly() { forceCalls++; finish(137); return this; }
        @Override public CompletableFuture<Process> onExit() { return exit; }
    }
}

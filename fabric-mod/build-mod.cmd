@echo off
setlocal
cd /d "%~dp0"
rem This intentionally nonexistent path makes Java's Unix socket bind fail safely.
rem This process-local workaround allows Java's Windows NIO selector to fall back to TCP.
set "JAVA_TOOL_OPTIONS=%JAVA_TOOL_OPTIONS% -Djdk.net.unixdomain.tmpdir=astra-no-unix-socket-directory"
call gradlew.bat --no-daemon build
if errorlevel 1 (
  echo Build failed. Ensure JAVA_HOME points to a Java 21 JDK.
  pause
  exit /b 1
)
echo Built build\libs\astra-voice-1.0.0.jar
pause

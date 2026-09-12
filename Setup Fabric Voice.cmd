@echo off
cd /d "%~dp0"
node scripts\setup-fabric.mjs %*
pause

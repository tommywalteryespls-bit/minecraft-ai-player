@echo off
cd /d "%~dp0"
node scripts\start-fabric.mjs
if errorlevel 1 pause

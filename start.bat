@echo off
REM Voice Agent - one-click launcher for Windows
REM Avoid double-clicking index.html (file://) which breaks /api/* calls.
REM Optional: set your domestic LLM key (default DeepSeek) before starting:
REM set DOMESTIC_LLM_KEY=sk-your-key-here

cd /d "%~dp0"
echo Starting Voice Agent local server...
start "VoiceAgent-Server" cmd /k "npm start"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"

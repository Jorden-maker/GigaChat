@echo off
REM ============================================================================
REM Stop GigaChat local HTTP server.
REM
REM Kills all caddy.exe processes. Safe because Caddy is stateless:
REM no disk writes besides logs, no queues, no graceful-shutdown needed.
REM
REM Usually you don't need this - just close the GigaChat Server window.
REM ============================================================================

taskkill /F /IM caddy.exe /T >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Caddy stopped.
) else (
    echo Caddy was not running.
)
timeout /t 1 /nobreak >nul

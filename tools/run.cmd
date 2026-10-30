@echo off
rem dsh-memory tidy worker launcher. Task Scheduler can only run .cmd, not .mjs.
rem Args are passed through: --if-due (catch-up run, skipped if last success < 20h), --dry-run (no network).
rem Keep this file ASCII-only: cmd.exe reads it in the OEM codepage, UTF-8 Chinese breaks parsing.
setlocal
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0tidy.mjs" %*
exit /b %ERRORLEVEL%

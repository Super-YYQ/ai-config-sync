@echo off
setlocal
title AI Config Sync

where node >nul 2>nul
if errorlevel 1 (
  echo AI Config Sync needs Node.js 18 or newer.
  echo Install Node.js, then double-click this file again.
  goto :failed
)

if exist "%~dp0dist\ai-config-sync.cjs" (
  node "%~dp0dist\ai-config-sync.cjs" ui %*
  if errorlevel 1 goto :failed
  goto :done
)

where ai-config-sync >nul 2>nul
if not errorlevel 1 (
  ai-config-sync ui %*
  goto :done
)

where npx >nul 2>nul
if errorlevel 1 (
  echo npm/npx was not found. Reinstall Node.js with npm enabled.
  goto :failed
)

npx --yes ai-config-sync ui %*
if errorlevel 1 goto :failed
goto :done

:failed
echo.
echo AI Config Sync could not start.
pause

:done
endlocal

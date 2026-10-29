@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, then reopen this installer.
  pause
  exit /b 1
)
call npm.cmd ci --no-audit --no-fund
if errorlevel 1 goto failed
call npm.cmd run deps:bot
if errorlevel 1 goto failed
call npm.cmd run runtime:install
if errorlevel 1 goto failed
echo Dependencies installed. Open the bot launcher to configure this computer.
pause
exit /b 0
:failed
echo Install failed. No bot was connected. Check network and Node.js version.
pause
exit /b 1


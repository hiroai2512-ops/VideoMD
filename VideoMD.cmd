@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0release\VideoMD-win32-x64\VideoMD.exe" (
  start "" "%~dp0release\VideoMD-win32-x64\VideoMD.exe"
) else (
  echo VideoMD.exe is not built yet. Run npm install and npm run package.
  pause
)

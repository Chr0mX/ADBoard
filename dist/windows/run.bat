@echo off
rem Starts ADBoard (ADBoard.exe). ADB and scrcpy are the copies in vendor\, not PATH.
title ADBoard
cd /d "%~dp0"

if not exist "%~dp0ADBoard.exe" (
  echo ADBoard binary ^(ADBoard.exe^) is missing next to this script.
  if exist "%~dp0PhoneControl.exe" echo Found the old name PhoneControl.exe: rename it to ADBoard.exe.
  echo From the repo: make package-windows
  pause
  exit /b 1
)

set "ADBOARD_ROLE=controller"
set "ADBOARD_BIND=0.0.0.0"
set "ADBOARD_PORT=3848"
set "ADBOARD_HOST=windows-host"
set "ADBOARD_HOST_ID=windows-host"
set "ADBOARD_VIDEO_SOURCE=auto"
rem Data folder: the ADBoard folder in the repository root (two levels up from dist\windows).
set "ADBOARD_APP_DATA_DIR=%~dp0..\..\ADBoard"
rem Remote access through a reverse proxy (Nginx Proxy Manager / Cloudflare) needs a password:
rem set "ADBOARD_PASSWORD=choose-a-long-passphrase"
rem Portable mode (keep data next to this script instead of %LOCALAPPDATA%\ADBoard):
rem set "ADBOARD_DATA_DIR=%~dp0ADBoard-data"

if exist "%~dp0vendor\adb\adb.exe" set "ADB_PATH=%~dp0vendor\adb\adb.exe"
if exist "%~dp0vendor\scrcpy\scrcpy.exe" set "SCRCPY_PATH=%~dp0vendor\scrcpy\scrcpy.exe"
if exist "%~dp0vendor\scrcpy\scrcpy-server" set "SCRCPY_SERVER_PATH=%~dp0vendor\scrcpy\scrcpy-server"

echo Starting ADBoard on every interface, port 3848
echo   this PC:    http://127.0.0.1:3848/
echo   other PCs:  http://THIS-PC-LAN-IP:3848/
echo Macros, scripts and settings are kept in %LOCALAPPDATA%\ADBoard ^(not in this folder^).
"%~dp0ADBoard.exe"
if errorlevel 1 pause

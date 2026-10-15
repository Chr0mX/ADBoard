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

set "PHONECONTROL_ROLE=controller"
set "PHONECONTROL_BIND=0.0.0.0"
set "PHONECONTROL_PORT=3848"
set "PHONECONTROL_HOST=windows-host"
set "PHONECONTROL_HOST_ID=windows-host"
set "PHONECONTROL_VIDEO_SOURCE=auto"
rem Remote access through a reverse proxy (Nginx Proxy Manager / Cloudflare) needs a password:
rem set "PHONECONTROL_PASSWORD=choose-a-long-passphrase"

if exist "%~dp0vendor\adb\adb.exe" set "ADB_PATH=%~dp0vendor\adb\adb.exe"
if exist "%~dp0vendor\scrcpy\scrcpy.exe" set "SCRCPY_PATH=%~dp0vendor\scrcpy\scrcpy.exe"
if exist "%~dp0vendor\scrcpy\scrcpy-server" set "SCRCPY_SERVER_PATH=%~dp0vendor\scrcpy\scrcpy-server"

echo Starting ADBoard on every interface, port 3848
echo   this PC:    http://127.0.0.1:3848/
echo   other PCs:  http://THIS-PC-LAN-IP:3848/
"%~dp0ADBoard.exe"
if errorlevel 1 pause

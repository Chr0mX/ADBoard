@echo off
rem Starts PhoneControl.exe. ADB and scrcpy are the copies in vendor\, not PATH.
cd /d "%~dp0"

if not exist "%~dp0PhoneControl.exe" (
  echo PhoneControl.exe is missing next to this script.
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

if exist "%~dp0vendor\adb\adb.exe" set "ADB_PATH=%~dp0vendor\adb\adb.exe"
if exist "%~dp0vendor\scrcpy\scrcpy.exe" set "SCRCPY_PATH=%~dp0vendor\scrcpy\scrcpy.exe"
if exist "%~dp0vendor\scrcpy\scrcpy-server" set "SCRCPY_SERVER_PATH=%~dp0vendor\scrcpy\scrcpy-server"

echo Starting PhoneControl on every interface, port 3848
echo   this PC:    http://127.0.0.1:3848/
echo   other PCs:  http://THIS-PC-LAN-IP:3848/
"%~dp0PhoneControl.exe"
if errorlevel 1 pause

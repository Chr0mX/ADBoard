@echo off
rem Double-click to start the mock controller and the web UI.
rem Agent http://127.0.0.1:3848   UI http://127.0.0.1:3847
cd /d "%~dp0"

where cargo >nul 2>&1 || (
  echo cargo was not found. Install Rust, then run this again.
  pause
  exit /b 1
)
where npm >nul 2>&1 || (
  echo npm was not found. Install Node.js, then run this again.
  pause
  exit /b 1
)

start "Phone Control agent" /D "%~dp0" cmd /k "set PHONECONTROL_FORCE_MOCK=1&& set PHONECONTROL_VIDEO_SOURCE=testpattern&& set PHONECONTROL_BIND=127.0.0.1&& cargo run -p phonecontrol-agent"
start "Phone Control UI" /D "%~dp0" cmd /k "set NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848&& npm run dev -- --webpack"

echo Agent  http://127.0.0.1:3848
echo UI     http://127.0.0.1:3847
timeout /t 5 /nobreak >nul
start "" "http://127.0.0.1:3847"

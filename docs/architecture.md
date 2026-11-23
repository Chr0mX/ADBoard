# ADBoard architecture

ADBoard is a multi-device Android desk. The browser never talks to ADB or USB. A Rust binary owns discovery, sessions, video, and input. The Next.js UI is either served by that binary (Windows pack) or pointed at it in development.

## Processes

| Process | Path | Default port |
|---|---|---|
| Web UI | `src/` | 3847 (`next dev`) |
| Agent / controller | `crates/adboard-agent` | 3848 controller, 3849 agent |
| Shared types | `crates/adboard-protocol` | — |

The same binary is a **controller** (default) or an **agent** (`ADBOARD_ROLE=agent`). Controllers serve the API and UI, own local devices, and can aggregate remote agents over `/ws/agent`. Agents register with a controller and advertise an HTTP base for video proxy.

## Layout

```text
Application
├── Entry
│   ├── crates/adboard-agent/src/main.rs
│   └── src/app/page.tsx
├── Core
│   ├── device_manager.rs   fleet, commands, QR, mesh merge
│   ├── session.rs          scrcpy / testpattern lifecycle
│   ├── scrcpy_video.rs / video.rs
│   ├── scrcpy_control.rs
│   ├── audio.rs            second scrcpy server (does not restart H264)
│   └── adb.rs / device_ops.rs / host_files.rs / app_controls.rs / logcat.rs
├── Services
│   ├── api.rs              HTTP + WS router, CORS, API token
│   └── mesh.rs / mesh_client.rs
├── UI
│   ├── adboard-app.tsx
│   ├── phone-screen.tsx
│   ├── desk/*
│   ├── hooks/use-device-video.ts   one shared stream per phone (lib/video/hub.ts)
│   └── lib/api/{client,auth}.ts
└── Data (data_dir.rs, shared_store.rs, migrate.rs; see docs/storage.md)
    ├── %LOCALAPPDATA%\ADBoard\macros         one .json per touch macro
    ├── …\shell_scripts                         one .json per script
    ├── …\config, logs, backups, files, temp
    └── browser storage adboard-*              working copy, mirrored to config\
```

## Critical paths

- **Video:** `WS /ws/devices/{serial}/video` sends text `VideoStatusFrame` then binary Annex-B access units. Handshake order for scrcpy is video socket, control socket, then the dummy byte. No `send_frame_meta` on the video path. Late subscribers request one keyframe (`RESET_VIDEO`) and drop P-frames until an IDR arrives.
- **Touch:** UI posts normalized points to `POST /api/input/pointer`. The agent maps each target with that device's decoded frame size and writes scrcpy `INJECT_TOUCH_EVENT`.
- **Auth:** Every `/api/*` and `/ws*` route except `/health`, `/api/health`, `/api/bootstrap`, `/api/session`, `/api/login`, `/api/logout` and `/api/account/password` (the sign-in routes check their own credentials) requires `x-adboard-token` (or `?token=` on WebSockets). The UI reads the token from `GET /api/bootstrap`. CORS allows `http://127.0.0.1:3847` and `http://localhost:3847` by default (`ADBOARD_DEV_ORIGINS`). Set `ADBOARD_TOKEN` when the bind is not loopback.
- **Wireless:** Address pairing and QR pairing (`WIFI:T:ADB;…`) live under `/api/devices/wireless`. Saved endpoints restore on startup.

## Connection detection and recovery

- **Phones:** the agent keeps one record of which phones are connected, with a connection generation per phone (`device_manager/connections.rs`). Two sources feed it and it counts each change once: the `adb track-devices` stream, read straight from the adb server (`device_manager/tracker.rs`), and the `adb devices -l` poll (`watcher.rs`), which stays the authority and the fallback (every 2 s, every 6 s while the stream delivers). A change wakes the poll at once. A phone that dropped and returned between two polls moves its generation, so its stream is restarted once; retries and restarts begun for an older generation stop when they find the generation changed. The Quiet Mode Loop is told about the same events.
- **Agent to controller:** the agent retries with a growing, jittered delay (1 s up to 30 s, `backoff.rs`), resets it after a connection that held, closes a controller that has gone silent for 20 s, and runs one connection worker only. `GET /health` shows the state. The controller closes an agent connection silent for 45 s, cancels a connection that was replaced, and a replaced connection cannot remove its successor.
- **Browser:** the page never replaces a real phone list with sample phones. When the agent cannot be reached it keeps the last list, shows the phones that were online as `stale`, and says when the list was last confirmed; it retries with a jittered backoff and an out-of-order answer never overwrites a newer one (`src/lib/devices/fleet-state.ts`).

## Operator vs developer

- Operators run `dist/windows/run.bat` (or Linux `adboard-agent` with `dist/windows/ui` beside it). The binary serves the static UI from disk and does not embed it or load `.env`.
- Developers run the agent and `NEXT_PUBLIC_AGENT_URL=… npm run dev` as described in the root README (and, for several computers, [deployment.md](deployment.md)).

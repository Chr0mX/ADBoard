# Phone Control architecture

Phone Control is a multi-device Android desk. The browser never talks to ADB or USB. A Rust binary owns discovery, sessions, video, and input. The Next.js UI is either served by that binary (Windows pack) or pointed at it in development.

## Processes

| Process | Path | Default port |
|---|---|---|
| Web UI | `src/` | 3847 (`next dev`) |
| Agent / controller | `crates/phonecontrol-agent` | 3848 controller, 3849 agent |
| Shared types | `crates/phonecontrol-protocol` | — |

The same binary is a **controller** (default) or an **agent** (`PHONECONTROL_ROLE=agent`). Controllers serve the API and UI, own local devices, and can aggregate remote agents over `/ws/agent`. Agents register with a controller and advertise an HTTP base for video proxy.

## Layout

```text
Application
├── Entry
│   ├── crates/phonecontrol-agent/src/main.rs
│   └── src/app/page.tsx
├── Core
│   ├── device_manager.rs   fleet, commands, QR, mesh merge
│   ├── session.rs          scrcpy / testpattern lifecycle
│   ├── scrcpy_video.rs / video.rs
│   ├── scrcpy_control.rs
│   ├── audio.rs            second scrcpy server (does not restart H264)
│   └── adb.rs / device_ops.rs / host_files.rs
├── Services
│   ├── api.rs              HTTP + WS router, CORS, API token
│   └── mesh.rs / mesh_client.rs
├── UI
│   ├── phone-control-app.tsx
│   ├── phone-screen.tsx
│   ├── desk/*
│   ├── hooks/use-device-video.ts
│   └── lib/api/{client,auth}.ts
└── Data
    ├── data/phonecontrol-files
    ├── data/wireless-adb.json
    └── localStorage phonecontrol-desk
```

## Critical paths

- **Video:** `WS /ws/devices/{serial}/video` sends text `VideoStatusFrame` then binary Annex-B access units. Handshake order for scrcpy is video socket, control socket, then the dummy byte. No `send_frame_meta` on the video path. Late subscribers request one keyframe (`RESET_VIDEO`) and drop P-frames until an IDR arrives.
- **Touch:** UI posts normalized points to `POST /api/input/pointer`. The agent maps each target with that device's decoded frame size and writes scrcpy `INJECT_TOUCH_EVENT`.
- **Auth:** Every `/api/*` and `/ws*` route except `/health`, `/api/health`, and `/api/bootstrap` requires `x-phonecontrol-token` (or `?token=` on WebSockets). The UI reads the token from `GET /api/bootstrap`. CORS allows `http://127.0.0.1:3847` and `http://localhost:3847` by default (`PHONECONTROL_DEV_ORIGINS`). Set `PHONECONTROL_TOKEN` when the bind is not loopback.
- **Wireless:** Address pairing and QR pairing (`WIFI:T:ADB;…`) live under `/api/devices/wireless`. Saved endpoints restore on startup.

## Operator vs developer

- Operators run `dist/windows/run.bat` (or Linux `phonecontrol-agent` with `dist/windows/ui` beside it). The binary serves the static UI from disk and does not embed it or load `.env`.
- Developers run the agent and `NEXT_PUBLIC_AGENT_URL=… npm run dev` as described in the root README.

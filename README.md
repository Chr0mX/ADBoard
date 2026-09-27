# Phone Control

Multi-device Android control center. **scrcpy/ADB is the transport; this app owns discovery, sessions, video/input abstraction, and the Web UI.** The browser never talks to ADB directly.

## Components

| Piece | Path | Port |
|---|---|---|
| Next.js Web UI | `src/` | **3847** |
| Rust agent (`phonecontrol-agent`) | `crates/phonecontrol-agent` | **3848** |
| Shared protocol types | `crates/phonecontrol-protocol` | — |

## Run locally (agent + UI)

### 1. Control agent

```bash
cargo run -p phonecontrol-agent
```

Listens on **http://127.0.0.1:3848** (override with `PHONECONTROL_PORT`).

- If `adb` is on `PATH` (or `ADB_PATH` is set), the agent polls `adb devices -l` and injects real taps/nav via `adb shell input`.
- If ADB is missing (or `PHONECONTROL_FORCE_MOCK=1`), it serves a **mock fleet** and stub inject.
- If `scrcpy` is on `PATH` (or `SCRCPY_PATH` / `SCRCPY_SERVER_PATH`), session start/stop/restart launches a **headless** scrcpy process (no GUI window). H264→browser decode is still stubbed; stream state is reported.

### 2. Web UI (pointed at the agent)

```bash
cp .env.example .env.local   # optional — defaults shown below
npm install
NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848 npm run dev
```

UI: **http://127.0.0.1:3847**

Without `NEXT_PUBLIC_AGENT_URL`, the UI keeps the in-browser mock client (no agent required).

### Environment flags

| Variable | Default | Purpose |
|---|---|---|
| `PHONECONTROL_PORT` | `3848` | Agent HTTP/WS listen port |
| `PHONECONTROL_HOST` | OS hostname | Host label on devices |
| `ADB_PATH` | `which adb` | Override ADB binary |
| `SCRCPY_PATH` | `which scrcpy` | Headless scrcpy CLI |
| `SCRCPY_SERVER_PATH` | — | Optional server jar/path (availability signal) |
| `SCRCPY_EXTRA_ARGS` | — | Extra space-separated args for scrcpy |
| `PHONECONTROL_FORCE_MOCK` | unset | `1`/`true` → ignore ADB, use mock fleet |
| `PHONECONTROL_AUTO_SESSION` | unset | `1`/`true` → auto-start scrcpy when a device comes online |
| `NEXT_PUBLIC_AGENT_URL` | unset | UI → agent base URL (mock client if unset) |

### Agent-only smoke checks

```bash
curl -s http://127.0.0.1:3848/health | jq
curl -s http://127.0.0.1:3848/api/devices | jq
curl -s http://127.0.0.1:3848/api/sessions | jq
curl -s -X POST http://127.0.0.1:3848/api/input/tap \
  -H 'content-type: application/json' \
  -d '{"mode":"all","targetIds":["s24","s23"],"normalized":{"x":0.5,"y":0.4}}' | jq
curl -s -X POST http://127.0.0.1:3848/api/input/nav \
  -H 'content-type: application/json' \
  -d '{"mode":"selected","targetIds":["s24"],"action":{"type":"home"}}' | jq
```

WebSocket: `ws://127.0.0.1:3848/ws` (device + session + tap/nav events).  
Video status: `ws://127.0.0.1:3848/ws/devices/{serial}/video` (JSON stream state; binary H264 later).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Agent status: `adb`, `scrcpy`, `inject` mode |
| GET | `/api/devices` | Current fleet (ADB or mock) |
| GET | `/api/sessions` | Per-serial stream state |
| GET | `/api/sessions/{serial}` | One session (`id` or serial) |
| POST | `/api/sessions/{serial}/start` | Headless scrcpy start (or honest idle stub) |
| POST | `/api/sessions/{serial}/stop` | Stop session |
| POST | `/api/sessions/{serial}/restart` | Restart session |
| POST | `/api/input/tap` | Normalized 0–1 → pixels + inject (`ok`/`stub`/`error`) |
| POST | `/api/input/nav` | `back`/`home`/`recent` → `adb shell input keyevent` |
| WS | `/ws` | `devices`, `session_updated`, `tap_result`, `nav_result`, `notice` |
| WS | `/ws/devices/{serial}/video` | Stream status frames (H264 pump TBD) |

## Real vs stubbed

| Real | Stubbed (TODO) |
|---|---|
| HTTP + WebSocket control plane | H264→browser decode / WebRTC |
| ADB discovery when `adb` exists | Full scrcpy control-socket inject (v1 uses `adb shell input`) |
| Real tap/nav inject via ADB | Per-frame video forwarder |
| Session manager start/stop/restart + stream state | Windows `PhoneControl.exe` packaging |
| Mock fleet + stub inject fallback | LXC multi-host mesh |

## Stack

- Frontend: Next.js · TypeScript · Tailwind · shadcn/ui
- Backend: Rust · Axum · Tokio (same codebase later as Windows `PhoneControl.exe` / Linux `phonecontrol-agent`)

## Layout

```text
Cargo.toml                 # workspace
crates/
  phonecontrol-protocol/   # shared wire types + coord/adb argv helpers
  phonecontrol-agent/      # Linux agent binary
src/                       # Next.js UI
  lib/api/client.ts        # mock or agent via NEXT_PUBLIC_AGENT_URL
```

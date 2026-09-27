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

- If `adb` is on `PATH` (or `ADB_PATH` is set), the agent polls `adb devices -l` and emits online / offline / unauthorized.
- If ADB is missing, it serves a **mock fleet** matching the UI seed devices.

### 2. Web UI (pointed at the agent)

```bash
cp .env.example .env.local   # optional — defaults shown below
npm install
NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848 npm run dev
```

UI: **http://127.0.0.1:3847**

Without `NEXT_PUBLIC_AGENT_URL`, the UI keeps the in-browser mock client (no agent required).

### Agent-only smoke checks

```bash
curl -s http://127.0.0.1:3848/health | jq
curl -s http://127.0.0.1:3848/api/devices | jq
curl -s -X POST http://127.0.0.1:3848/api/input/tap \
  -H 'content-type: application/json' \
  -d '{"mode":"all","targetIds":["s24","s23"],"normalized":{"x":0.5,"y":0.4}}' | jq
```

WebSocket: `ws://127.0.0.1:3848/ws` (device snapshots + tap/nav events).

## API surface (this slice)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Agent status + ADB mode (`available` \| `mock`) |
| GET | `/api/devices` | Current fleet |
| POST | `/api/input/tap` | Normalized 0–1 point → per-device pixel map + stub inject |
| POST | `/api/input/nav` | `back` / `home` / `recent` broadcast (stub inject) |
| WS | `/ws` | `devices`, `device_updated`, `tap_result`, `nav_result`, `notice` |

## Real vs stubbed

| Real | Stubbed (TODO) |
|---|---|
| HTTP + WebSocket control plane | scrcpy-server / H264 video pipeline |
| ADB discovery when `adb` exists | Actual touch/key injection into devices |
| Mock fleet fallback matching UI | WebRTC, Windows `PhoneControl.exe` packaging |
| Normalized → device-pixel mapping | Per-device `/ws/devices/{serial}/video` |

## Stack

- Frontend: Next.js · TypeScript · Tailwind · shadcn/ui
- Backend: Rust · Axum · Tokio (same codebase later as Windows `PhoneControl.exe` / Linux `phonecontrol-agent`)

## Layout

```text
Cargo.toml                 # workspace
crates/
  phonecontrol-protocol/   # shared wire types
  phonecontrol-agent/      # Linux agent binary
src/                       # Next.js UI
  lib/api/client.ts        # mock or agent via NEXT_PUBLIC_AGENT_URL
```

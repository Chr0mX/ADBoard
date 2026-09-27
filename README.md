# Phone Control

Multi-device Android control center. **scrcpy/ADB is the transport; this app owns discovery, sessions, video/input abstraction, and the Web UI.** The browser never talks to ADB directly.

## Components

| Piece | Path | Port |
|---|---|---|
| Next.js Web UI | `src/` | **3847** |
| Rust binary (`phonecontrol-agent`) | `crates/phonecontrol-agent` | **3848** controller / **3849** agent |
| Shared protocol types | `crates/phonecontrol-protocol` | — |

Same binary, two roles via `--role` / `PHONECONTROL_ROLE`:

- **controller** (default) — serves the UI API, owns local devices, aggregates remote agents
- **agent** — local ADB/scrcpy only; registers with a controller over WebSocket

## Run locally (single process — backward compatible)

```bash
# Terminal 1 — controller with local mock/ADB fleet
cargo run -p phonecontrol-agent
# → http://127.0.0.1:3848

# Terminal 2 — Web UI
cp .env.example .env.local   # optional
npm install
NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848 npm run dev
# → http://127.0.0.1:3847
```

Without `NEXT_PUBLIC_AGENT_URL`, the UI keeps the in-browser mock client.

## Multi-host mesh demo (two local processes)

Simulates Windows PC + Proxmox LXC without a second machine. Mock profiles tag devices to different hosts; the controller merges them into one fleet.

```bash
# Terminal 1 — controller (windows mock slice)
PHONECONTROL_ROLE=controller \
PHONECONTROL_PORT=3848 \
PHONECONTROL_HOST=windows-host \
PHONECONTROL_HOST_ID=windows-host \
PHONECONTROL_FORCE_MOCK=1 \
PHONECONTROL_MOCK_PROFILE=windows \
cargo run -p phonecontrol-agent

# Terminal 2 — agent (lxc mock slice → registers with controller)
PHONECONTROL_ROLE=agent \
PHONECONTROL_PORT=3849 \
PHONECONTROL_HOST=lxc-agent-01 \
PHONECONTROL_HOST_ID=lxc-agent-01 \
PHONECONTROL_FORCE_MOCK=1 \
PHONECONTROL_MOCK_PROFILE=lxc \
PHONECONTROL_CONTROLLER_URL=ws://127.0.0.1:3848/ws/agent \
cargo run -p phonecontrol-agent

# Terminal 3 — UI pointed at the controller
NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848 npm run dev
```

Smoke:

```bash
curl -s http://127.0.0.1:3848/health | jq
curl -s http://127.0.0.1:3848/api/hosts | jq
curl -s http://127.0.0.1:3848/api/devices | jq '.[] | {id,host,hostId}'
# Tap across both hosts (S24 local + Pixel remote)
curl -s -X POST http://127.0.0.1:3848/api/input/tap \
  -H 'content-type: application/json' \
  -d '{"mode":"multi","targetIds":["s24","pixel"],"normalized":{"x":0.5,"y":0.4}}' | jq
```

## Real Windows + Linux LXC (notes)

| Host | Role | Notes |
|---|---|---|
| Windows PC | `controller` (or agent) | Same Rust binary; later packaged as `PhoneControl.exe`. USB phones via ADB. |
| Proxmox LXC | `agent` | Run `phonecontrol-agent --role agent` with `PHONECONTROL_CONTROLLER_URL=ws://<controller>:3848/ws/agent`. Pass USB devices into the LXC (`usb0: …` / `cgroup` device allow) or use network ADB. |
| Browser | UI | Always talks to the **controller** (`NEXT_PUBLIC_AGENT_URL`). |

Full Proxmox USB passthrough cookbook is out of scope; ensure `adb devices` works inside the LXC before expecting mesh discovery.

## Environment flags

| Variable | Default | Purpose |
|---|---|---|
| `PHONECONTROL_ROLE` / `--role` | `controller` | `controller` or `agent` |
| `PHONECONTROL_PORT` | `3848` / `3849` | Listen port (agent defaults to 3849) |
| `PHONECONTROL_HOST` | OS hostname | Host display label on devices |
| `PHONECONTROL_HOST_ID` | same as host | Stable mesh id |
| `PHONECONTROL_CONTROLLER_URL` | `ws://127.0.0.1:3848/ws/agent` | Agent → controller (http(s) base also accepted) |
| `PHONECONTROL_MOCK_PROFILE` | `all` (agent → `lxc`) | `all` / `windows` / `lxc` mock slices |
| `ADB_PATH` | `which adb` | Override ADB binary |
| `SCRCPY_PATH` | `which scrcpy` | Headless scrcpy CLI |
| `SCRCPY_SERVER_PATH` | — | Optional server jar/path |
| `SCRCPY_EXTRA_ARGS` | — | Extra space-separated args for scrcpy |
| `PHONECONTROL_FORCE_MOCK` | unset | `1`/`true` → ignore ADB, use mock fleet |
| `PHONECONTROL_AUTO_SESSION` | unset | Auto-start scrcpy when a device comes online |
| `NEXT_PUBLIC_AGENT_URL` | unset | UI → **controller** base URL |

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Role, host id, adb/scrcpy/inject, registered agent count |
| GET | `/api/devices` | Merged fleet (local + agents) |
| GET | `/api/hosts` | Local + registered agents |
| GET | `/api/sessions` | Local + remote session snapshot |
| GET | `/api/sessions/{serial}` | One session (`id` or serial) |
| POST | `/api/sessions/{serial}/start\|stop\|restart` | Proxied to owning agent when remote |
| POST | `/api/input/tap` | Normalized 0–1 → pixels; local inject + remote proxy |
| POST | `/api/input/nav` | `back`/`home`/`recent` → keyevent (proxied) |
| WS | `/ws` | UI: `devices`, `hosts`, `session_updated`, tap/nav |
| WS | `/ws/agent` | Agent registration / heartbeats / command proxy |
| WS | `/ws/devices/{serial}/video` | Stream status frames (H264 pump TBD) |

## Real vs stubbed

| Real | Stubbed (TODO) |
|---|---|
| HTTP + WebSocket control plane | H264→browser decode / WebRTC |
| ADB discovery when `adb` exists | Full scrcpy control-socket inject (v1 uses `adb shell input`) |
| Real tap/nav inject via ADB | Per-frame video forwarder |
| Session manager start/stop/restart + stream state | Windows `PhoneControl.exe` packaging |
| Multi-host mesh (controller + agents) | Deep Proxmox USB docs |

## Stack

- Frontend: Next.js · TypeScript · Tailwind · shadcn/ui
- Backend: Rust · Axum · Tokio (same codebase as Windows `PhoneControl.exe` / Linux `phonecontrol-agent`)

## Layout

```text
Cargo.toml                 # workspace
crates/
  phonecontrol-protocol/   # shared wire types + mesh frames + coord/adb helpers
  phonecontrol-agent/      # controller + agent binary
src/                       # Next.js UI (HOSTS grouping in device panel)
  lib/api/client.ts        # mock or agent via NEXT_PUBLIC_AGENT_URL
```

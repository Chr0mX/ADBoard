# Phone Control

Multi-device Android control center. **scrcpy/ADB is the transport; this app owns discovery, sessions, video/input abstraction, and the Web UI.** The browser never talks to ADB directly.

## Components

| Piece | Path | Port |
|---|---|---|
| Next.js Web UI | `src/` | **3847** |
| Rust binary (`phonecontrol-agent`) | `crates/phonecontrol-agent` | **3848** controller / **3849** agent |
| Shared protocol types | `crates/phonecontrol-protocol` | — |

Same binary, two roles via `--role` / `PHONECONTROL_ROLE`:

- **controller** (default) — serves the UI API, owns local devices, aggregates remote agents, **proxies video WS**
- **agent** — local ADB/scrcpy/testpattern only; registers with a controller over WebSocket

## Video (H264 over WebSocket)

`WS /ws/devices/{serial}/video`:

| Frame | Meaning |
|---|---|
| **Text** JSON | `VideoStatusFrame` — `stream`, `backend`, optional `codec`/`codecString`/`width`/`height`/`framing` |
| **Binary** | One **Annex-B** H264 access unit (start-code NALs; keyframes carry SPS/PPS + IDR) |

UI decodes with **WebCodecs** `VideoDecoder` onto a canvas. Switching the active device only changes the video WS subscription — agent sessions stay up.

### Synthetic test pattern (no phones / no scrcpy)

Default when scrcpy is missing (`PHONECONTROL_VIDEO_SOURCE=auto`):

```bash
PHONECONTROL_FORCE_MOCK=1 \
PHONECONTROL_VIDEO_SOURCE=testpattern \
cargo run -p phonecontrol-agent
```

- Prefers live **ffmpeg** `testsrc` → raw H264 on stdout when `ffmpeg` is on `PATH` (or `FFMPEG_PATH`)
- Falls back to embedded fixture `crates/phonecontrol-agent/fixtures/testpattern.h264` (360×640 loop)
- Session `backend` = `testpattern`, `stream` = `streaming` (honest — not a stub wallpaper)

Opening the phone screen (or any client on the video WS) auto-starts the pump; closing the WS does **not** stop the session.

### Real scrcpy

When `scrcpy` is installed and `PHONECONTROL_VIDEO_SOURCE=auto|scrcpy`, session start launches headless scrcpy. Raw H264 socket→WS forwarder is still TBD — use `testpattern` to exercise browser decode today.

## Run locally (single process)

```bash
# Terminal 1 — controller (mock + synthetic video)
PHONECONTROL_FORCE_MOCK=1 \
PHONECONTROL_VIDEO_SOURCE=testpattern \
cargo run -p phonecontrol-agent
# → http://127.0.0.1:3848

# Terminal 2 — Web UI
cp .env.example .env.local   # optional
npm install
NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848 npm run dev -- -p 3847
# → http://127.0.0.1:3847
```

Without `NEXT_PUBLIC_AGENT_URL`, the UI keeps the in-browser mock client (no video WS).

## Multi-host mesh demo (two local processes)

```bash
# Terminal 1 — controller (windows mock slice + testpattern)
PHONECONTROL_ROLE=controller \
PHONECONTROL_PORT=3848 \
PHONECONTROL_HOST=windows-host \
PHONECONTROL_HOST_ID=windows-host \
PHONECONTROL_FORCE_MOCK=1 \
PHONECONTROL_MOCK_PROFILE=windows \
PHONECONTROL_VIDEO_SOURCE=testpattern \
cargo run -p phonecontrol-agent

# Terminal 2 — agent (lxc mock slice → registers + advertises http_base for video proxy)
PHONECONTROL_ROLE=agent \
PHONECONTROL_PORT=3849 \
PHONECONTROL_HOST=lxc-agent-01 \
PHONECONTROL_HOST_ID=lxc-agent-01 \
PHONECONTROL_FORCE_MOCK=1 \
PHONECONTROL_MOCK_PROFILE=lxc \
PHONECONTROL_VIDEO_SOURCE=testpattern \
PHONECONTROL_CONTROLLER_URL=ws://127.0.0.1:3848/ws/agent \
PHONECONTROL_HTTP_BASE=http://127.0.0.1:3849 \
cargo run -p phonecontrol-agent

# Terminal 3 — UI → controller
NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848 npm run dev -- -p 3847
```

Smoke:

```bash
curl -s http://127.0.0.1:3848/health | jq
curl -s http://127.0.0.1:3848/api/hosts | jq
# Video status (then binary AUs) — use websocat / browser
# websocat ws://127.0.0.1:3848/ws/devices/s24/video
```

## Real Windows + Linux LXC (notes)

| Host | Role | Notes |
|---|---|---|
| Windows PC | `controller` (or agent) | Same Rust binary; later packaged as `PhoneControl.exe`. USB phones via ADB. |
| Proxmox LXC | `agent` | `--role agent` + `PHONECONTROL_CONTROLLER_URL`. Set `PHONECONTROL_HTTP_BASE` to a controller-reachable URL for video proxy. |
| Browser | UI | Always talks to the **controller** (`NEXT_PUBLIC_AGENT_URL`). |

## Environment flags

| Variable | Default | Purpose |
|---|---|---|
| `PHONECONTROL_ROLE` / `--role` | `controller` | `controller` or `agent` |
| `PHONECONTROL_PORT` | `3848` / `3849` | Listen port (agent defaults to 3849) |
| `PHONECONTROL_HOST` | OS hostname | Host display label on devices |
| `PHONECONTROL_HOST_ID` | same as host | Stable mesh id |
| `PHONECONTROL_CONTROLLER_URL` | `ws://127.0.0.1:3848/ws/agent` | Agent → controller |
| `PHONECONTROL_HTTP_BASE` | `http://127.0.0.1:$PORT` | Advertised for controller video proxy |
| `PHONECONTROL_MOCK_PROFILE` | `all` (agent → `lxc`) | `all` / `windows` / `lxc` |
| `PHONECONTROL_VIDEO_SOURCE` | `auto` | `auto` / `testpattern` / `scrcpy` / `off` |
| `FFMPEG_PATH` | `which ffmpeg` | Live testsrc encoder for testpattern |
| `ADB_PATH` | `which adb` | Override ADB binary |
| `SCRCPY_PATH` | `which scrcpy` | Headless scrcpy CLI |
| `SCRCPY_SERVER_PATH` | — | Optional server jar/path |
| `SCRCPY_EXTRA_ARGS` | — | Extra space-separated args for scrcpy |
| `PHONECONTROL_FORCE_MOCK` | unset | `1`/`true` → ignore ADB, use mock fleet |
| `PHONECONTROL_AUTO_SESSION` | unset | Auto-start session when a device comes online |
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
| WS | `/ws/devices/{serial}/video` | Status JSON + Annex-B H264; remote proxied via agent `http_base` |

## Real vs stubbed

| Real | Stubbed (TODO) |
|---|---|
| HTTP + WebSocket control plane | WebRTC |
| ADB discovery when `adb` exists | Full scrcpy control-socket inject (v1 uses `adb shell input`) |
| Real tap/nav inject via ADB | scrcpy raw H264 socket → WS forwarder |
| Session manager + synthetic H264 testpattern → browser WebCodecs | Windows `PhoneControl.exe` packaging |
| Multi-host mesh + video proxy | Deep Proxmox USB docs |

## Stack

- Frontend: Next.js · TypeScript · Tailwind · shadcn/ui · WebCodecs
- Backend: Rust · Axum · Tokio (same codebase as Windows `PhoneControl.exe` / Linux `phonecontrol-agent`)

## Layout

```text
Cargo.toml                 # workspace
crates/
  phonecontrol-protocol/   # shared wire types + mesh frames + coord/adb helpers
  phonecontrol-agent/      # controller + agent binary + video hub
    fixtures/testpattern.h264
src/                       # Next.js UI
  hooks/use-device-video.ts
  lib/api/client.ts
```

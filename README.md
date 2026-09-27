# Phone Control

Multi-device Android control center Web UI. **scrcpy/ADB is the transport; this app owns discovery, sessions, video/input abstraction, and the browser UI.** The browser never talks to ADB directly.

## This slice

Runnable Next.js UI with a **mocked device fleet** and a thin client API (`src/lib/api/client.ts`) shaped for a future Rust + ADB/scrcpy backend.

- Active phone screen (mock Android frame) with Back / Home / Recent
- Device grid with click / Ctrl·Shift multi-select
- Control modes: Selected / Multi / All Devices
- Tap normalization (0–1) mapped to each target device resolution
- Status bar: name · link · resolution · FPS · bitrate

## Run locally

```bash
npm install
npm run dev
```

Dev server binds to **http://127.0.0.1:3847** (see `package.json` scripts).

```bash
npm run build && npm run start
```

## Stack

- Next.js (App Router) · TypeScript · Tailwind CSS · shadcn/ui

## Mock vs next

| Now (mock) | Next (real) |
|---|---|
| 4 seeded devices in `src/lib/devices/mock-data.ts` | ADB discovery via Rust host / LXC agent |
| Local `devicesClient` delays + console logs | HTTP + WebSocket control plane |
| Gradient “stream” placeholder | H264 over WS (later WebRTC) |
| Tap/nav broadcast feedback in UI | scrcpy-server input injection |

## Project layout

```text
src/
  app/                 # Next.js routes
  components/
    phone-control/     # Wireframe UI
    ui/                # shadcn primitives
  hooks/               # usePhoneControl
  lib/
    api/client.ts      # Thin client — swap for real backend
    devices/           # Types, mock data, coord helpers
```

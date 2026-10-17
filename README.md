<p align="center">
  <img src="site/assets/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">ADBoard</h1>

<p align="center"><b>ANDROID DEVICE CONTROL</b></p>

<p align="center">
  <b>Every device. One dashboard.</b><br>
  A self-hosted web interface for scrcpy, ADB, multi-device control, and automation.
</p>

<p align="center">
  <a href="https://chr0mx.github.io/ADBoard/">Website</a> ·
  <a href="#run-on-windows-operator">Quick start</a> ·
  <a href="#remote-access-nginx-proxy-manager--cloudflare">Remote access</a> ·
  <a href="docs/architecture.md">Architecture</a>
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="site/assets/icon-live-control.svg" width="32" height="32" alt=""><br>
      <b>Live Control</b><br>
      Screen mirroring and input. Low-latency H.264 in the browser, touch, keyboard and navigation keys.
    </td>
    <td width="50%" valign="top">
      <img src="site/assets/icon-automation.svg" width="32" height="32" alt=""><br>
      <b>Macros &amp; Shell Automation</b><br>
      Macros: record or build finger-touch macros and run them per phone. Shell Automation: app, file and shell-command jobs across many phones.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="site/assets/icon-adb-terminal.svg" width="32" height="32" alt=""><br>
      <b>ADB Terminal</b><br>
      Shell and device commands. Run ADB shell, install APKs, push and pull files.
    </td>
    <td width="50%" valign="top">
      <img src="site/assets/icon-device-fleet.svg" width="32" height="32" alt=""><br>
      <b>Device Fleet</b><br>
      Manage every connected phone. USB and wireless devices across Windows and Linux hosts in one grid.
    </td>
  </tr>
</table>

## How it works

**scrcpy/ADB is the transport; ADBoard owns discovery, sessions, video/input abstraction, and the Web UI.** The browser never talks to ADB directly.

## Components

| Piece | Path | Port |
|---|---|---|
| Next.js Web UI | `src/` | **3847** |
| Rust binary (`adboard-agent`) | `crates/phonecontrol-agent` | **3848** controller / **3849** agent |
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

### Real scrcpy (raw H264 → WebSocket)

When **ADB** and **scrcpy-server** are available and `PHONECONTROL_VIDEO_SOURCE=auto|scrcpy`, session start:

1. `adb push` the server jar to the device  
2. `adb forward tcp:PORT localabstract:scrcpy`  
3. Runs the **standalone server** (not the GUI client) with:

```bash
CLASSPATH=/data/local/tmp/phonecontrol-scrcpy-server.jar \
  app_process / com.genymobile.scrcpy.Server <version> \
  tunnel_forward=true audio=false control=true cleanup=false \
  raw_stream=true send_dummy_byte=true video_codec=h264 max_size=1280
```

4. TCP-connects the video socket and the control socket, then reads the one-byte handshake on the video socket (`adb forward` accepts before the device is listening, and scrcpy writes that byte only after both sockets are accepted). The bytes after that are **Annex-B access units**, published on the video hub (`backend: scrcpy`). Finger down, move, and up on the page are written to the control socket as scrcpy touch messages, in the decoded video's pixel size.

`raw_stream=true` is the current scrcpy-supported way to get a bare H264 socket (the client no longer supports `--record-format=h264`). Override version with `SCRCPY_SERVER_VERSION` if the jar filename does not include `vX.Y.Z`.

**USB host verify:**

```bash
# on a machine with adb + a phone + scrcpy release extracted
export ADB_PATH=$(which adb)
export SCRCPY_PATH=/path/to/scrcpy
export SCRCPY_SERVER_PATH=/path/to/scrcpy-server   # or scrcpy-server-v4.1
export PHONECONTROL_VIDEO_SOURCE=auto
cargo run -p phonecontrol-agent
# UI → open online device → status shows backend: scrcpy / streaming + canvas frames
```

Without phones in this VM, CI uses the Annex-B reader + fixture path (`PHONECONTROL_SCRCPY_FIXTURE=1` forces `backend: scrcpy` with the embedded H264 loop).

## Run on Windows (operator)

Copy `dist/windows/` to the USB host, drop ADB + scrcpy into `vendor/`, then double-click `run.bat`. The same process serves the control page:

```text
http://127.0.0.1:3848/
```

Details: [`dist/windows/README.md`](dist/windows/README.md). Architecture: [`docs/architecture.md`](docs/architecture.md).

When the bind is not loopback, set `PHONECONTROL_TOKEN` so only clients that know the secret can call the API.

## Run locally (developer, two processes)

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

## Real Windows + Linux LXC

| Host | Role | Notes |
|---|---|---|
| Windows PC | `controller` (or agent) | Packaged as `ADBoard.exe` — see **Windows host pack** below |
| Proxmox LXC | `agent` | `--role agent` + `PHONECONTROL_CONTROLLER_URL`. Set `PHONECONTROL_HTTP_BASE` to a controller-reachable URL for video proxy. |
| Browser | UI | Always talks to the **controller** (`NEXT_PUBLIC_AGENT_URL`). |

### Fetch ADB + scrcpy (`make fetch-deps`)

Downloads go to **`./temp/`** only (gitignored). Binaries are installed into:

| Target | Paths |
|---|---|
| Linux | `tools/linux/adb/`, `tools/linux/scrcpy/` |
| Windows pack | `dist/windows/vendor/adb/`, `dist/windows/vendor/scrcpy/` |

```bash
make fetch-deps                         # host OS (linux here)
make fetch-deps FETCH_TARGET=windows    # Windows vendor only
make fetch-deps FETCH_TARGET=all        # both
make fetch-deps FETCH_FORCE=1           # re-download
# PowerShell (Windows host): .\scripts\fetch-deps.ps1
```

The agent auto-discovers vendored binaries (env `ADB_PATH` / `SCRCPY_PATH` / `SCRCPY_SERVER_PATH` still win).

### Windows host pack (`dist/windows/`)

Zip-ready folder (no MSI / signed installer). Same binary as Linux; renamed to `ADBoard.exe`.

```text
dist/windows/
  ADBoard.exe           # Windows controller (double-click run.bat)
  run.bat                    # double-click: exe + vendor\adb and vendor\scrcpy
  Start-ADBoard.ps1
  .env.example
  README.md
  vendor/adb/                # make fetch-deps FETCH_TARGET=windows
  vendor/scrcpy/
```

**Build on Linux / CI** (MinGW gnu target — works in this environment; MSVC needs a Windows SDK):

```bash
# once: sudo apt-get install -y gcc-mingw-w64-x86-64
#       rustup target add x86_64-pc-windows-gnu
make build-windows      # → target/x86_64-pc-windows-gnu/release/adboard-agent.exe
make package-windows    # → dist/windows/ADBoard.exe + docs
```

Scripts: `scripts/build-windows.sh`, `scripts/package-windows.sh`, `scripts/fetch-deps.sh`. Linker config: `.cargo/config.toml`.

**On the Windows USB host:**

1. Copy `dist/windows/` to the PC (or clone the repo).
2. `.\scripts\fetch-deps.ps1` (or `make fetch-deps FETCH_TARGET=windows` from WSL).
3. Double-click `dist\windows\run.bat` (or `run.bat` in the repo root).

```text
http://127.0.0.1:3848
```

4. Point the UI: `NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848`.

**Bind address** (`PHONECONTROL_BIND`):

| Value | Use when |
|---|---|
| `127.0.0.1` | Browser UI on this Windows PC only |
| `0.0.0.0` (`run.bat`) | LAN browser or a remote agent can open port 3848. Allow TCP 3848 in Windows Firewall. |

```powershell
.\Start-ADBoard.ps1 -Bind 0.0.0.0
```

**Pair Linux LXC agent** (controller on Windows, agent on LXC):

```bash
# on LXC — use the Windows LAN IP, not 127.0.0.1
PHONECONTROL_ROLE=agent \
PHONECONTROL_PORT=3849 \
PHONECONTROL_HOST=lxc-agent-01 \
PHONECONTROL_HOST_ID=lxc-agent-01 \
PHONECONTROL_CONTROLLER_URL=ws://<windows-lan-ip>:3848/ws/agent \
PHONECONTROL_HTTP_BASE=http://<lxc-lan-ip>:3849 \
./adboard-agent
```

Mock without phones: `.\Start-ADBoard.ps1 -Mock` (testpattern video).

## Remote access (Nginx Proxy Manager + Cloudflare)

ADBoard can be published on a hostname such as `adboard.example.com` behind Nginx Proxy Manager, with Cloudflare's proxy in front. The UI talks to the same origin and switches to `wss://` on HTTPS, so no URLs need changing.

**Create an account first.** Without one, ADBoard refuses to hand out its API token to any request that arrived through a proxy (it shows "Password required for remote access"). Anyone who reaches the site could otherwise control the phones, run ADB shell commands and browse host files.

- Open ADBoard on the host's own network (e.g. `http://127.0.0.1:3848`) and click **Set password** in the header, or start it once with `PHONECONTROL_PASSWORD` (username `admin`, or `PHONECONTROL_USERNAME`).
- Visitors through the proxy get a sign-in form (username and password). Sessions last 30 days in an HttpOnly, Secure, SameSite=Strict cookie.
- Signed-in users change the password from the **account name** in the header. That needs the current password and signs out every other browser.
- The account is stored as a salted PBKDF2-SHA256 hash in `adboard-auth.json` next to the executable (`PHONECONTROL_AUTH_FILE` to move it). `PHONECONTROL_PASSWORD` only sets the first password; to recover a forgotten one, start with `PHONECONTROL_PASSWORD=… PHONECONTROL_RESET_PASSWORD=1`.
- `PHONECONTROL_ALLOW_PROXY_WITHOUT_PASSWORD=1` skips all of this when Cloudflare Access already guards the hostname.

On Windows: `.\Start-ADBoard.ps1 -Bind 0.0.0.0 -Password '…'` sets the first password. LAN access without a proxy keeps working without an account.

**Nginx Proxy Manager** (proxy host):
- Scheme `http`, forward to the ADBoard host, port `3848`. Turn on **Websockets Support**.
- SSL: request a certificate (or use a Cloudflare Origin certificate) and turn on **Force SSL**.
- Advanced tab, so long-lived video sockets are not cut:
  ```nginx
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  proxy_buffering off;
  ```
- Use its own subdomain. Serving ADBoard under a path such as `example.com/adboard` is not supported.

**Cloudflare:**
- SSL/TLS mode **Full (strict)**; Network → **WebSockets** on (default).
- Turn **Rocket Loader off** (it rewrites scripts).
- Leave caching at defaults: ADBoard sends `no-cache` for the page, `sw.js` and the manifest, `no-store` for `/api/*`, and long-lived `immutable` caching only for hashed `/_next/static/*` files.
- Bot Fight Mode or "I'm Under Attack" can challenge the app's background requests; skip them for this hostname or use Cloudflare Access.
- Cloudflare Free and Pro accept at most 100 MB per request. ADBoard sends files over 64 MB in 32 MB chunks, so APK installs and file pushes up to 256 MB still work.
- Optional: firewall port 3848 so only the Nginx Proxy Manager host can reach it.

ADBoard pings every WebSocket every 25 s, under Cloudflare's 100 s and nginx's default 60 s idle limits, so a still phone screen does not drop the video. The API token never appears in URLs (browsers send it as a WebSocket subprotocol, servers as the `x-phonecontrol-token` header), so it stays out of proxy and Cloudflare logs. Remote agents can join a controller published this way with `PHONECONTROL_CONTROLLER_URL=wss://adboard.example.com/ws/agent` and the same `PHONECONTROL_TOKEN` on both sides.

## Layout tips

- **Folding side panels:** fold Screens or Devices (chevron in the panel header, or Alt+Shift+[ / ]) and the Back/Home/Recent row, tools and stream options move into that freed column, so the phone gets the full height. With both folded they sit on the right.
- **Grid view:** one slim bar above the tiles holds who gets touches (Selected / Multi / All), Back/Home/Recent, pages, **Arrangement** (opens a strip under the bar: **Fit all** or Columns × Rows; the tiles shrink to make room instead of being covered), **Macro** and Exit. On phones the bar is two short rows (modes, then actions) at 36px. **⌃⌃** hides the bar so the tiles use the full height; the **Controls** chip brings it back. Each tile's **Include** tick box and **Focus** button sit in the strip under the picture, so nothing covers the phone's screen. With more phones than cells, ‹ › pages through them. The layout and the bar state are saved per browser.

## Touch macros

**Macros** in the desk header holds virtual tabs of single- and multi-touch steps. You can preview and drag touch points, scale them to each phone's resolution, and import or export Auto Clicker `config.txt` files. The preview can show a phone's live screen under the touch points. **Macro** in the Control tool row opens a side panel for the phone you're controlling: its own macro, live screen and Start / Pause / Stop, without moving other phones or the Macros page. The Macros page preview has phone chips to pick any phone's live screen.

- **Shared:** macros are kept on ADBoard and shared by every browser. Differing copies are merged, never replaced, and **Versions** restores earlier copies.
- **Per phone:** **Phones** gives each phone its own macro, with its own Start / Pause / Stop and live status. Runs live in ADBoard, so they keep going when the browser closes, and stopping or disconnecting one phone leaves the others running. Runs stop when ADBoard itself is closed.

See [docs/macros.md](docs/macros.md).

## Temporary files

Staged APKs, file pushes/pulls and upload chunks go to `<repo root>/temp/` (git-ignored), or `temp/` next to the executable when the pack runs without the repo. Set `PHONECONTROL_TEMP` to use another folder.

APK installs use adb's normal (streamed) install first. If a phone rejects that (`splice failed: EINVAL … Performing Streamed Install`), ADBoard retries with `--no-streaming`, then with push + `pm install`.

## Desktop shortcuts

Control view on a desktop-width window. They use Alt+Shift (⌥⇧ on a Mac) so they still work while keyboard injection sends plain keys to the phone, and they are never forwarded to the phone. Buttons show their shortcut in the tooltip.

| Keys | Action |
|---|---|
| Alt+Shift+B / H / R | Back / Home / Recent |
| Alt+Shift+G | Grid view |
| Alt+Shift+F | Fill window |
| Alt+Shift+M | More tools (quality, size, audio, screen off, clipboard) |
| Alt+Shift+[ / ] | Fold or unfold the Screens / Devices panel |

## Environment flags

| Variable | Default | Purpose |
|---|---|---|
| `PHONECONTROL_ROLE` / `--role` | `controller` | `controller` or `agent` |
| `PHONECONTROL_BIND` | `0.0.0.0` | Listen IP — `127.0.0.1` for loopback-only; `0.0.0.0` for LAN / LXC agents |
| `PHONECONTROL_PORT` | `3848` / `3849` | Listen port (agent defaults to 3849) |
| `PHONECONTROL_HOST` | OS hostname | Host display label on devices |
| `PHONECONTROL_HOST_ID` | same as host | Stable mesh id |
| `PHONECONTROL_CONTROLLER_URL` | `ws://127.0.0.1:3848/ws/agent` | Agent → controller |
| `PHONECONTROL_HTTP_BASE` | `http://127.0.0.1:$PORT` | Advertised for controller video proxy |
| `PHONECONTROL_MOCK_PROFILE` | `all` (agent → `lxc`) | `all` / `windows` / `lxc` |
| `PHONECONTROL_VIDEO_SOURCE` | `auto` | `auto` / `testpattern` / `scrcpy` / `off` — auto prefers scrcpy when ADB + scrcpy-server are ready |
| `FFMPEG_PATH` | `which ffmpeg` | Live testsrc encoder for testpattern |
| `ADB_PATH` | vendored `tools/…` / `vendor/…`, else `which adb` | Override ADB binary |
| `SCRCPY_PATH` | vendored scrcpy, else `which scrcpy` | Optional scrcpy CLI (version probe / sibling server jar) |
| `SCRCPY_SERVER_PATH` | next to binary / vendored / distro paths | **Required for real frames** — standalone server jar |
| `SCRCPY_SERVER_VERSION` | from filename / `scrcpy --version` | First arg to `com.genymobile.scrcpy.Server` |
| `SCRCPY_MAX_SIZE` | `1280` | Server `max_size=` |
| `SCRCPY_SERVER_OPTS` | — | Extra `key=value` server options |
| `SCRCPY_EXTRA_ARGS` | — | Also maps `--max-size` / `-b` / `--max-fps` into server opts |
| `PHONECONTROL_SCRCPY_FIXTURE` | unset | `1` → mock scrcpy backend with embedded H264 (no USB) |
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
| POST | `/api/input/gesture` | Timed single/multi-touch strokes (finger slots 0–9), played on the agent; every finger released (proxied) |
| WS | `/ws` | UI: `devices`, `hosts`, `session_updated`, tap/nav |
| WS | `/ws/agent` | Agent registration / heartbeats / command proxy |
| WS | `/ws/devices/{serial}/video` | Status JSON + Annex-B H264; remote proxied via agent `http_base` |

## Real vs stubbed

| Real | Stubbed (TODO) |
|---|---|
| HTTP + WebSocket control plane | WebRTC |
| ADB discovery when `adb` exists | Full scrcpy control-socket inject (v1 uses `adb shell input`) |
| Real tap/nav inject via ADB | Signed MSI / auto-update |
| Session manager + **scrcpy-server `raw_stream` → Annex-B video WS** | Deep Proxmox USB docs |
| Synthetic H264 testpattern → browser WebCodecs | — |
| Multi-host mesh + video proxy | — |
| Windows pack scripts (`ADBoard.exe` via MinGW cross-build) | — |

## Stack

- Frontend: Next.js · TypeScript · Tailwind · shadcn/ui · WebCodecs
- Backend: Rust · Axum · Tokio (same codebase as Windows `ADBoard.exe` / Linux `adboard-agent`)

## Layout

```text
Cargo.toml                 # workspace
Makefile                   # build-windows / package-windows / test-linux
.cargo/config.toml         # MinGW linker for x86_64-pc-windows-gnu
scripts/
  build-windows.sh
  package-windows.sh
crates/
  phonecontrol-protocol/   # shared wire types + mesh frames + coord/adb helpers
  phonecontrol-agent/      # controller + agent binary + video hub
    fixtures/testpattern.h264
dist/windows/              # Windows host pack (exe from make package-windows)
src/                       # Next.js UI
  hooks/use-device-video.ts
  lib/api/client.ts
```

# Deployment: hosts, agents and the Windows pack

Back to the [README](../README.md). This page covers more than one computer, fetching ADB and scrcpy, and building the Windows pack. For a single PC, the README's quick start is enough.

## Real Windows + Linux LXC

| Host | Role | Notes |
|---|---|---|
| Windows PC | `controller` (or agent) | Packaged as `ADBoard.exe`. See **Windows host pack** below. |
| Proxmox LXC | `agent` | `--role agent` + `ADBOARD_CONTROLLER_URL`. Set `ADBOARD_HTTP_BASE` to a controller-reachable URL for video proxy. |
| Browser | UI | Always talks to the **controller** (`NEXT_PUBLIC_AGENT_URL`). |

## Fetch ADB + scrcpy (`make fetch-deps`)

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

## Windows host pack (`dist/windows/`)

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

**Build on Linux or CI** with the MinGW gnu target. MSVC needs the Windows SDK.

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

**Bind address** (`ADBOARD_BIND`):

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
ADBOARD_ROLE=agent \
ADBOARD_PORT=3849 \
ADBOARD_HOST=lxc-agent-01 \
ADBOARD_HOST_ID=lxc-agent-01 \
ADBOARD_CONTROLLER_URL=ws://<windows-lan-ip>:3848/ws/agent \
ADBOARD_HTTP_BASE=http://<lxc-lan-ip>:3849 \
./adboard-agent
```

Mock without phones: `.\Start-ADBoard.ps1 -Mock` (testpattern video).

## Multi-host mesh demo (three local processes, no phones)

```bash
# Terminal 1 — controller (windows mock slice + testpattern)
ADBOARD_ROLE=controller \
ADBOARD_PORT=3848 \
ADBOARD_HOST=windows-host \
ADBOARD_HOST_ID=windows-host \
ADBOARD_FORCE_MOCK=1 \
ADBOARD_MOCK_PROFILE=windows \
ADBOARD_VIDEO_SOURCE=testpattern \
cargo run -p adboard-agent

# Terminal 2 — agent (lxc mock slice → registers + advertises http_base for video proxy)
ADBOARD_ROLE=agent \
ADBOARD_PORT=3849 \
ADBOARD_HOST=lxc-agent-01 \
ADBOARD_HOST_ID=lxc-agent-01 \
ADBOARD_FORCE_MOCK=1 \
ADBOARD_MOCK_PROFILE=lxc \
ADBOARD_VIDEO_SOURCE=testpattern \
ADBOARD_CONTROLLER_URL=ws://127.0.0.1:3848/ws/agent \
ADBOARD_HTTP_BASE=http://127.0.0.1:3849 \
cargo run -p adboard-agent

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

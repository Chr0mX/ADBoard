# ADBoard — Windows USB host pack

Drop-in folder for running the **controller** on a Windows PC that has phones on USB.
Same Rust binary as Linux `adboard-agent`; here it is named `ADBoard.exe`.

This is **not** a signed installer / MSI. Copy the folder, drop in ADB + scrcpy, run the script.

## Layout

```text
ADBoard.exe           # controller (or agent) binary
ui/                        # control page served at http://127.0.0.1:3848/
run.bat                    # double-click: starts ADBoard.exe, vendor tools only
Start-ADBoard.ps1     # same launch, with -Mock / -Bind switches
.env.example               # copy to .env and edit (optional; script also sets defaults)
README.md                  # this file
vendor/
  adb/                     # put adb.exe (+ AdbWinApi.dll, AdbWinUsbApi.dll) here
  scrcpy/                  # put scrcpy.exe + scrcpy-server here
```

## One-time setup

1. **ADB + scrcpy (automated)** from the repo root:

```powershell
.\scripts\fetch-deps.ps1
# or from WSL/Linux: make fetch-deps FETCH_TARGET=windows
```

Caches under `./temp/`; installs into `vendor/adb/` and `vendor/scrcpy/`. See those READMEs for a manual download fallback.

2. Enable **USB debugging** on each phone and accept the RSA prompt.

## Run (controller on this PC)

Double-click `run.bat` in this folder, or from the repo root. It starts `ADBoard.exe` and uses `vendor\adb` and `vendor\scrcpy` beside it. The same process serves the control page from `ui/` — open that URL in a browser. A separate Node server is not required.

```text
http://127.0.0.1:3848/
```

PowerShell, when you need `-Mock` or a different bind address:

```powershell
.\Start-ADBoard.ps1
# → http://127.0.0.1:3848
```

Or manually:

```powershell
$env:PHONECONTROL_ROLE = "controller"
$env:PHONECONTROL_BIND = "127.0.0.1"   # UI on this machine only
$env:PHONECONTROL_PORT = "3848"
$env:PHONECONTROL_HOST = "windows-host"
$env:ADB_PATH = "$PWD\vendor\adb\adb.exe"
$env:SCRCPY_PATH = "$PWD\vendor\scrcpy\scrcpy.exe"
.\ADBoard.exe
```

The page at `/` talks to this process on the same origin. A dev checkout can still point a separate Next server at the agent with `NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848`.

## Bind address: `127.0.0.1` vs `0.0.0.0`

| Bind | When |
|---|---|
| `127.0.0.1` | Browser UI runs on this Windows PC. Not reachable from the LAN. |
| `0.0.0.0` (`run.bat`) | Another machine’s browser, or a remote agent, can open this controller. Allow TCP 3848 in Windows Firewall. |

Set via `PHONECONTROL_BIND` (also accepts any IPv4 literal).

## Pair a Linux LXC agent

On the Windows controller, bind all interfaces so the LXC can connect:

```powershell
$env:PHONECONTROL_BIND = "0.0.0.0"
.\ADBoard.exe
```

On the Linux agent (same binary, agent role):

```bash
PHONECONTROL_ROLE=agent \
PHONECONTROL_PORT=3849 \
PHONECONTROL_HOST=lxc-agent-01 \
PHONECONTROL_HOST_ID=lxc-agent-01 \
PHONECONTROL_CONTROLLER_URL=ws://<windows-lan-ip>:3848/ws/agent \
PHONECONTROL_HTTP_BASE=http://<lxc-lan-ip>:3849 \
cargo run -p phonecontrol-agent --release
# or: ./adboard-agent
```

- `PHONECONTROL_CONTROLLER_URL` — Windows host LAN IP (not `127.0.0.1` from the LXC’s perspective).
- `PHONECONTROL_HTTP_BASE` — URL the **controller** can use to proxy video WS back to this agent.

UI always talks to the **controller** only.

## Mock / no phones

```powershell
$env:PHONECONTROL_FORCE_MOCK = "1"
$env:PHONECONTROL_VIDEO_SOURCE = "testpattern"
$env:PHONECONTROL_MOCK_PROFILE = "windows"
.\Start-ADBoard.ps1
```

## Building this folder (from Linux / CI)

```bash
make package-windows
# → dist/windows/ADBoard.exe + docs (cross-compiled x86_64-pc-windows-gnu)
```

Do not commit real `adb.exe` / scrcpy redistributables into git — download them onto the Windows host as above.

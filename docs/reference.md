# Reference: environment flags, API and video

Back to the [README](../README.md). The agent is `crates/adboard-agent`; its router is `crates/adboard-agent/src/api/mod.rs`.

## Environment flags

Older `PHONECONTROL_*` names are still read when the `ADBOARD_*` one is not set; the log warns once.

| Variable | Default | Purpose |
|---|---|---|
| `ADBOARD_DATA_DIR` | see [storage.md](storage.md) | Data folder (macros, scripts, settings, logs, backups); set it for portable mode |
| `ADBOARD_ROLE` / `--role` | `controller` | `controller` or `agent` |
| `ADBOARD_BIND` | `0.0.0.0` | Listen address. Use `127.0.0.1` for this computer only, `0.0.0.0` for LAN and LXC agents |
| `ADBOARD_PORT` | `3848` / `3849` | Listen port (agent defaults to 3849) |
| `ADBOARD_HOST` | OS hostname | Host display label on devices |
| `ADBOARD_HOST_ID` | same as host | Stable mesh id |
| `ADBOARD_CONTROLLER_URL` | `ws://127.0.0.1:3848/ws/agent` | Agent → controller |
| `ADBOARD_HTTP_BASE` | `http://127.0.0.1:$PORT` | Advertised for controller video proxy |
| `ADBOARD_MOCK_PROFILE` | `all` (agent → `lxc`) | `all` / `windows` / `lxc` |
| `ADBOARD_VIDEO_SOURCE` | `auto` | `auto`, `testpattern`, `scrcpy` or `off`. `auto` uses scrcpy when ADB and scrcpy-server are ready |
| `FFMPEG_PATH` | `which ffmpeg` | Live testsrc encoder for testpattern |
| `ADB_PATH` | vendored `tools/…` / `vendor/…`, else `which adb` | Override ADB binary |
| `SCRCPY_PATH` | vendored scrcpy, else `which scrcpy` | Optional scrcpy CLI (version probe / sibling server jar) |
| `SCRCPY_SERVER_PATH` | next to the binary, vendored, or distro paths | **Required for real frames.** The standalone server jar |
| `SCRCPY_SERVER_VERSION` | from filename / `scrcpy --version` | First arg to `com.genymobile.scrcpy.Server` |
| `SCRCPY_MAX_SIZE` | `1280` | Server `max_size=` |
| `SCRCPY_SERVER_OPTS` | none | Extra `key=value` server options |
| `SCRCPY_EXTRA_ARGS` | none | Also maps `--max-size`, `-b` and `--max-fps` to server options |
| `ADBOARD_SCRCPY_FIXTURE` | unset | `1` → mock scrcpy backend with embedded H264 (no USB) |
| `ADBOARD_FORCE_MOCK` | unset | `1`/`true` → ignore ADB, use mock fleet |
| `ADBOARD_AUTO_SESSION` | unset | Auto-start session when a device comes online |
| `ADBOARD_ALLOWED_HOSTS` | unset | Comma-separated host names (for example `adboard.local`) allowed to load the token without a password. IP addresses and `localhost` are always allowed |
| `ADBOARD_MAX_VIRTUAL_DISPLAYS` | `1` | Extra Android displays (virtual displays) allowed per phone, 1 to 4. Can also be set in Settings, which takes priority. See [virtual-display.md](virtual-display.md) |
| `ADBOARD_OCR_MODELS` | vendored `tools/ocr` / `vendor/ocr` | Folder with `text-detection.rten` and `text-recognition.rten` for macro text steps |
| `NEXT_PUBLIC_AGENT_URL` | unset | UI → **controller** base URL |

More flags the agent reads (checked against `crates/adboard-agent/src`):

| Variable | Default | Purpose |
|---|---|---|
| `ADBOARD_TOKEN` | unset | API token clients must send (`x-adboard-token`). Set it when the bind is not loopback |
| `ADBOARD_PASSWORD` / `ADBOARD_USERNAME` | unset / `admin` | First account; see [Remote access](remote-access.md) |
| `ADBOARD_RESET_PASSWORD` | unset | `1` with `ADBOARD_PASSWORD` replaces a forgotten password |
| `ADBOARD_AUTH_FILE` | `config\auth.json` in the data folder | Where the account hash is stored |
| `ADBOARD_ALLOW_PROXY_WITHOUT_PASSWORD` | unset | `1` skips the password requirement behind a proxy (for example Cloudflare Access) |
| `ADBOARD_DEV_ORIGINS` | `http://127.0.0.1:3847,http://localhost:3847` | Comma-separated origins allowed by CORS (the dev UI) |
| `ADBOARD_CONNECT_DISPLAY_SIZE` | unset | `WxH` (for example `1080x1920`) set with `wm size` when a phone comes online; `native` or `reset` leaves phones alone. The agent resets it when the phone disconnects |
| `ADBOARD_WIRELESS` | `config\wireless_devices.json` | File of saved wireless endpoints restored at start |
| `ADBOARD_FILES` | `files` in the data folder | Folder for Downloads, APKs, Recordings and Screenshots |
| `ADBOARD_TEMP` | `temp` in the data folder | Staged APKs, file transfers and upload chunks |

| `ADBOARD_ADB_TRACK` | on | `0` / `off` turns off the `adb track-devices` stream (the poll then runs alone, every 2 s) |
| `ADBOARD_ADB_TRACK_ADDR` | `127.0.0.1:5037` (or `ANDROID_ADB_SERVER_PORT`) | Where the adb server listens, for the `track-devices` stream |

Testing only: `ADBOARD_MOCK_COUNT` (number of mock phones), `ADBOARD_MOCK_VITALS=1` (change one mock phone's CPU every 2 s), `ADBOARD_TESTPATTERN_FPS` (test pattern frame rate), `ADBOARD_QUIET_MIN_SECS` and `ADBOARD_QUIET_TICK_MS` (shorten the Quiet Mode Loop's minimum quiet time and its check period).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Role, host id, adb/scrcpy/inject, registered agent count, `instance` (new at every start), `uptimeSecs`, `ready` (the first look at the phones is done); on an agent also `controllerLink` (`state` connecting / connected / retrying, `failures`, `connections`, `lastError`, `lastConnectedMs`, `nextAttemptMs`) |
| GET | `/api/devices` | Merged fleet (local + agents) |
| GET | `/api/hosts` | Local + registered agents |
| GET | `/api/sessions` | Local + remote session snapshot |
| GET | `/api/sessions/{serial}` | One session (`id` or serial) |
| POST | `/api/sessions/{serial}/start\|stop\|restart` | Proxied to owning agent when remote |
| POST | `/api/input/tap` | Normalized 0–1 → pixels; local inject + remote proxy |
| POST | `/api/input/nav` | `back`/`home`/`recent` → keyevent (proxied) |
| POST | `/api/input/gesture` | Timed single/multi-touch strokes (finger slots 0–9), played on the agent; every finger released (proxied) |
| GET | `/api/events` · `/api/events/summary` | Event history (filters, paging) and 24-hour counts; `POST /api/events/clear` deletes it |
| GET / PUT | `/api/notifications` | Discord settings and delivery status (the webhook URL is never returned); `POST /api/notifications/test` sends a test |
| GET | `/api/ocr/status` | Whether text steps can read screens here (models installed) |
| POST | `/api/ocr/read` | Text on a phone's screen now: `{deviceId, area?, query?}` → lines with 0–1 boxes, and the query's matches (proxied) |
| GET / PUT | `/api/store/{name}` | Shared macros, scripts, queue, schedules and settings (revisions; a stale save gets 409 with the current copy) |
| GET / POST | `/api/store/{name}/history` · `/restore` | Earlier saved versions, and restoring one |
| GET | `/api/system/storage` | Data folder paths, saved files, migration result |
| POST | `/api/system/open-folder` · `/backup` | Open a data folder on the ADBoard PC; back up the data folder |
| GET | `/api/apps/icon` · `/api/apps/meta` | An app's icon and name, read from the phone's APK and cached (`?serial=&package=`) |
| WS | `/ws` | UI: `devices`, `hosts`, `session_updated`, tap/nav |
| WS | `/ws/agent` | Agent registration / heartbeats / command proxy |
| WS | `/ws/devices/{serial}/video` | Status JSON + Annex-B H264; remote proxied via agent `http_base` |
| WS | `/ws/devices/{serial}/logcat` | Live logcat: first message `{package, level}`, then `{lines}` batches (proxied) |
| POST | `/api/device/command` | Device ops on many phones, incl. `appDetail`, `appop`, `permission`, `standby`, `batteryExempt`, `netBlock`, `appState`, `activities`, `assistLaunch`, `intent`, `shizuku`, `tweak` ([phone-controls.md](phone-controls.md)) |

This is the main part of the surface, not all of it. Also in the router: `/api/bootstrap`, `/api/session`, `/api/login`, `/api/input/pointer`, `/api/scrcpy/options`, `/api/devices/wireless`, `/api/macro/*`, `/api/quiet-cycle` (the Quiet Mode Loop: `GET`, `PUT {intervalSecs, peekSecs}` where `intervalSecs` is the quiet time and `peekSecs` the 1 to 5 second screen-on time, and `POST /stop`, which puts the phones back) and `/api/device/pull`.

## Video (H264 over WebSocket)

`WS /ws/devices/{serial}/video`:

| Frame | Meaning |
|---|---|
| **Text** JSON | `VideoStatusFrame`: `stream`, `backend`, and optional `codec`, `codecString`, `width`, `height` and `framing` |
| **Binary** | One **Annex-B** H264 access unit (start-code NALs; keyframes carry SPS/PPS + IDR) |

The UI decodes the frames with **WebCodecs** `VideoDecoder` and draws them on a canvas. Switching the active device only changes the video subscription, so agent sessions stay up.

### Keyframe requests, retries and the storm brake

`POST /api/input/refresh` takes an optional `reason` (`connect`, `decode-backlog`, `stall`, ...). The agent shares one scrcpy `RESET_VIDEO` between requests that arrive before its keyframe has come out, spaces resets of one phone at least 0.8 s apart, and answers a storm (four or more resets of one phone in ten seconds) by slowing that phone to one every 4 s and logging who asked. A reset is never sent before a new stream's first frame, because scrcpy-server dies on one. A socket still holding back delta frames after 2 s asks again only while the phone's session is `streaming`; while it is `starting` or `error` it logs why, at most every 10 s. A phone whose start failed is retried by the agent after 3, 6, 12 and 24 s and then every 30 s, only while it is online and has a viewer; each retry first runs `pkill -f com.genymobile.scrcpy.Server` on the phone.

### Control socket and page reports

Each phone's scrcpy control socket carries touches, keys, text, clipboard and keyframe requests. Keyframe requests go ahead of everything queued. A finger or mouse move that finds the queue full is dropped (the next one supersedes it); a down, up or cancel waits. A message that waited a second or more is logged once per 10 s as `scrcpy control socket is backed up`. The page also sends one request at a time and, while one is on its way, keeps only the newest move.

`POST /api/diagnostics/video` takes a page's report of a video problem (`serial`, `event`, `pipeline`, `counters`, `lastClose`, ...). The agent logs it as one `WARN` line, `page reports a video problem`, at most 4000 bytes with the pipeline first, and does nothing else with it. Events: `pictures-arrive-none-shown`, `connect-refresh-timeout`, `decode-backlog`, `decoder-rebuilt`, `decoder-fallback`, `mse-stalled`, `no-heartbeat`, `socket-closed`, and `health-not-rendering`, `health-page-dropping`, `health-agent-holding` (the page's picture check found that stage stopped and repaired it); each at most once per phone every 15 s.

The video heartbeat (a status frame every 5 s) also carries `instance` (the agent process), `sourceFrames` (pictures the phone has produced), `sourceIdleMs` (since the last one), `sentFrames` (pictures sent on this socket), `heldBack` and `waitingForKeyframe`. The page uses them to tell a still screen from an agent that holds a socket back.

### An idle viewer (not used by the current page)

The agent still understands this message, but the current page never sends it. A page whose viewer wanted no pictures would send `{"type":"viewer","active":false}` on the video socket. The agent then stops sending pictures on that socket; status frames, the 5 s heartbeat and WebSocket pings continue, so the connection is still watched. `{"type":"viewer","active":true}` brings the pictures back, starting with the cached SPS/PPS and keyframe and a request for a fresh one. An agent that does not know the message ignores it and the page drops the pictures itself. The connection is closed only when the viewer closes, the phone goes away, or the connection fails: no pictures, a still screen or an idle viewer never count as failure.

### How a video socket ends

The agent closes a video socket with an application close code and a short reason whenever it ends it itself, so the page can tell which layer failed. A close with no code (1005, 1006) means the connection itself failed. The page keeps the last close, a count per kind, the number of sockets opened and how long the last recovery took in `window.__adboardPerf.snapshot()` (open the page with `?perf=1`).

| Code | Reason | Layer |
|---|---|---|
| 4004 | unknown device | the phone is not known to this agent |
| 4005 | stream could not start | the phone's stream failed to start (the reason is in the status frame before it) |
| 4008 | client stopped reading | this browser did not take data for 30 s (a frozen tab) |
| 4009 | client sent nothing, not even a pong | this browser was silent for 70 s |
| 4010 | remote agent video unreachable | the controller could not open the remote agent's video socket (8 s limit) |
| 4011 | remote agent video link ended | the remote agent's video socket ended while the browser was connected |
| 4012 | video channel shut down | the agent stopped the phone's video channel |

The page itself closes a socket (the viewer closed, a refresh, a replaced connection) without any of these, and records why in `lastIntentionalClose`. A socket that stops sending its heartbeat for 15 s is closed by the page and recorded as `stale` (code 0). Each unexpected close is recorded with the phone, how long it was open, the code and reason, who ended it (`page`, `controller`, `remote-agent`, `network`, `server`), how long before it the last heartbeat and last picture arrived, whether the decoder had been rebuilt and that a reconnect follows. After 4004 (unknown phone) the page waits at least 10 s before asking again, and after 4005 at least 3 s. The agent logs the same facts when a video socket ends: seconds open, pictures sent, time since the last picture and heartbeat, whether the viewer was idle, and the close code the browser sent.

Keyframes: scrcpy's `RESET_VIDEO` restarts the phone's encoder, so the agent spaces requests for one phone at least 0.8 s apart. The first goes out at once; the others inside that time are sent as one request afterwards, so each viewer still gets a keyframe made after it asked. A socket opened after a phone's stream stopped or restarted is not replayed the earlier stream's cached SPS/PPS or keyframe.

### Synthetic test pattern (no phones / no scrcpy)

Default when scrcpy is missing (`ADBOARD_VIDEO_SOURCE=auto`):

```bash
ADBOARD_FORCE_MOCK=1 \
ADBOARD_VIDEO_SOURCE=testpattern \
cargo run -p adboard-agent
```

- Prefers live **ffmpeg** `testsrc` → raw H264 on stdout when `ffmpeg` is on `PATH` (or `FFMPEG_PATH`)
- Falls back to embedded fixture `crates/adboard-agent/fixtures/testpattern.h264` (360×640 loop)
- The session reports `backend` = `testpattern` and `stream` = `streaming`. It is a real video stream, not a placeholder image.

Opening the phone screen (or any client on the video WS) auto-starts the pump; closing the WS does **not** stop the session.

### Real scrcpy (raw H264 → WebSocket)

When **ADB** and **scrcpy-server** are available and `ADBOARD_VIDEO_SOURCE=auto|scrcpy`, session start:

1. `adb push` the server jar to the device  
2. `adb forward tcp:PORT localabstract:scrcpy`  
3. Runs the **standalone server** (not the GUI client) with:

```bash
CLASSPATH=/data/local/tmp/adboard-scrcpy-server.jar \
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
export ADBOARD_VIDEO_SOURCE=auto
cargo run -p adboard-agent
# UI → open online device → status shows backend: scrcpy / streaming + canvas frames
```

Without phones in this VM, CI uses the Annex-B reader + fixture path (`ADBOARD_SCRCPY_FIXTURE=1` forces `backend: scrcpy` with the embedded H264 loop).

## Temporary files and APK installs

Staged APKs, file pushes/pulls and upload chunks go to `temp/` in the data folder. Set `ADBOARD_TEMP` to use another folder.

APK installs use adb's normal (streamed) install first. If a phone rejects that (`splice failed: EINVAL … Performing Streamed Install`), ADBoard retries with `--no-streaming`, then with push + `pm install`.

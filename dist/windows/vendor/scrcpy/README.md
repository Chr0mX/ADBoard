# scrcpy for Windows (not committed)

**Automated (preferred):** from the repo root:

```bash
make fetch-deps FETCH_TARGET=windows
# or on Windows PowerShell:
.\scripts\fetch-deps.ps1
```

Downloads go to `./temp/`; this folder receives the scrcpy win64 release (`scrcpy.exe`, `scrcpy-server`, DLLs, …).

**Manual:** download a **Windows** release from Genymobile/scrcpy and copy at least:

- `scrcpy.exe`
- `scrcpy-server` (or `scrcpy-server.jar`)
- any DLLs shipped next to `scrcpy.exe`

`Start-ADBoard.ps1` sets `SCRCPY_PATH` / `SCRCPY_SERVER_PATH` when those files exist. The agent also auto-discovers vendored paths.

ADBoard owns discovery and the Web UI; scrcpy-server is the capture transport for video (`raw_stream=true` over an adb-forwarded TCP socket → Annex-B on the video WebSocket). Inject v1 still uses `adb shell input`. Use `PHONECONTROL_VIDEO_SOURCE=testpattern` to validate the browser path without phones.

Do **not** commit scrcpy redistributables to this repo.

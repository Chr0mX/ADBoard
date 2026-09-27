# scrcpy for Windows (not committed)

Download a **Windows** release of scrcpy (Genymobile/scrcpy), then copy into this folder at least:

- `scrcpy.exe`
- `scrcpy-server` (or `scrcpy-server.jar` depending on the release layout)
- any DLLs shipped next to `scrcpy.exe` (SDL, etc.)

`Start-PhoneControl.ps1` sets `SCRCPY_PATH` / `SCRCPY_SERVER_PATH` when those files exist.

Phone Control owns discovery and the Web UI; scrcpy is the capture/inject transport. Raw H264 socket→WebSocket forwarding is still evolving — use `PHONECONTROL_VIDEO_SOURCE=testpattern` to validate the browser path without phones.

Do **not** commit scrcpy redistributables to this repo; download onto the Windows host.

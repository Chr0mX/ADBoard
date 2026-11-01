# Independent Android display (virtual display)

Status: **design plus the tested command builder.** Nothing starts a virtual display yet. The builder is `crates/adboard-agent/src/virtual_display.rs`.

## Idea
scrcpy-server 3.x creates a `VirtualDisplay` itself when started with `new_display=<W>x<H>/<dpi>`, encodes it, and sends input to it. ADBoard runs it as a **second scrcpy server on the same phone**, next to the physical-screen one. No helper app is needed.

## Design
- **Session.** Same jar and launch path as `scrcpy_video.rs`, with its own `scid` (socket `scrcpy_<scid:08x>`) and forward port (34183-36182). The physical-screen session and the audio server are untouched.
- **Key.** `<serial>#vd<N>` (`display_key`). The hub, the Grid tile and `/ws/devices/{key}/video` use it; adb commands use the real serial.
- **Display id.** Read from the server log (`parse_display_id`). Needed for `am start --display <id>` and `input -d <id>` (`am_start_args`, `input_args`).
- **Input.** Touch and keys over the scrcpy control socket already reach that display. Shell `input` needs `-d`.
- **Lifecycle.** The display lives as long as the server process; stopping the session ends it. Limit of 2 per phone (`MAX_PER_PHONE`).
- **Safety.** The command is one shell string, so `validate` rejects anything but package-name characters and bounded numbers; it does not escape.

## Still to build
1. Spike on a real phone: `scrcpy --new-display=1080x1920/320 --start-app=<package>`. Confirm the option names, the display-id log line and that the phone allows it.
2. Agent: session start for a `#vd` key, endpoint `POST /api/devices/{serial}/virtual-display`, `Device.kind/parentSerial/displayId` in the protocol.
3. UI: a "Virtual display" action in the phone menu, then a normal tile.
4. Route macro and typed input through `input_args`.
5. Pin the scrcpy version in `fetch-deps` (it downloads "latest").

## Risks
Android 10+ needed (11-13+ more reliable); some vendors restrict secondary displays; apps that cannot resize or block capture may fail; the on-screen keyboard may stay on the main display; no audio from the virtual display yet; each display is another phone-side encode and stream.

# Independent Android display (virtual display)

Status: **built, not yet tried on a phone.** The agent side was not compiled in the authoring environment (no crate registry); run `cargo test --workspace` and try it on an Android 13+ phone before relying on it.

## Idea
scrcpy-server 3.x creates a `VirtualDisplay` itself when started with `new_display=<W>x<H>/<dpi>`, encodes it, and sends input to it. ADBoard runs it as a **second scrcpy server on the same phone**, next to the physical-screen one. No helper app is needed.

## Design
- **Session.** Same jar and launch path as `scrcpy_video.rs`, with its own `scid` (socket `scrcpy_<scid:08x>`) and forward port (34183-36182). The physical-screen session and the audio server are untouched.
- **Key.** `<serial>#vd<N>` (`display_key`). The hub, the Grid tile and `/ws/devices/{key}/video` use it; adb commands use the real serial.
- **Display id.** Read from the server log (`parse_display_id`). Needed for `am start --display <id>` and `input -d <id>` (`am_start_args`, `input_args`).
- **Input.** Touch and keys over the scrcpy control socket already reach that display. Shell `input` needs `-d`.
- **Lifecycle.** The display lives as long as the server process; stopping the session ends it. One extra display per phone by default; `ADBOARD_MAX_VIRTUAL_DISPLAYS` raises it (1-4, `max_per_phone`).
- **Safety.** The command is one shell string, so `validate` rejects anything but package-name characters and bounded numbers; it does not escape.

## How it works now
- Agent: `POST /api/devices/{id}/virtual-display` (`width`, `height`, `dpi`, `startApp`, `keepContent`), `GET` the same path (list and limit), `DELETE /api/virtual-display/{key}`, `POST /api/virtual-display/{key}/launch` (`{component}`).
- Each display is a second scrcpy server (`scrcpy_video.rs`, `start_scrcpy_raw_capture` with a `#vd` key); settings are kept in `SessionManager.virtual_specs`; `list_local_devices` adds one device per display, so the video hub, the grid and the video socket treat it as a phone.
- Checks before starting: Android API 33+, scrcpy-server 3.0+ (set `SCRCPY_VERSION` for `fetch-deps`), per-phone limit, and field validation.
- Touch, multi-touch, keys and typed text go over the display's own control socket. The shell `input` fallbacks (tap, swipe, nav keys) add `-d <display id>` and fail rather than touch the phone's own screen if the id is not known.
- UI: Control tab, a phone's `⋯` menu, "Add virtual display" (size, density, app) and, on a virtual display, "Virtual display" (start an app, close).

## Not done yet
- Other adb-based device actions on a virtual display (reboot, app commands, macro shell steps) use the `#vd` key as the adb serial and fail with an adb error; they do not reach the phone. Route them to the real serial where it makes sense.
- Virtual displays of phones on another agent (controller mode): create the display from the agent the phone is plugged into.
- A display whose phone is unplugged is not cleaned up until the agent restarts.
- Confirm on a real phone: the server option names, the display-id log line (`parse_display_id`), and that apps start on the display.
- Audio, and pinning the scrcpy version in `fetch-deps`.

## Decisions
- Target phones: **Android 13+** (API 33, `sdk_supported`; read `ro.build.version.sdk` before creating).
- **No audio** for now (`audio=false`).
- Size and density are chosen per display at creation; changing them means restarting that display.

## Risks
Some vendors restrict secondary displays; apps that cannot resize or block capture may fail; the on-screen keyboard may stay on the main display; no audio from the virtual display yet; each display is another phone-side encode and stream.

# Controls audit: phone farm, scrcpy and automation

Every requested control, mapped to the code that implements it. **Existing** controls were left as they were; **Added** ones are new.

Testing used the mock fleet (`PHONECONTROL_FORCE_MOCK=1`) in Chromium at desktop and phone widths. Items marked **device** still need a check on real phones.

## 1. Bottom taskbar (phone layout)

| Control | Status | Where / how |
| --- | --- | --- |
| Back, Home, Recent Apps | Existing | Android keys via `adb shell input keyevent` (`device-nav-bar.tsx`) |
| Minimize | Existing | Folds Tools and Stats into chips. Android has no minimize key. |
| Volume Down, Volume Up, Power | Existing | Android keys |
| Pinned tools | Existing + 4 added | Rotate, Fullscreen, Pop out and Quiet mode can now be pinned. The limit is 19, so every tool fits. The bar stays centred and scrolls when full. |

## 2. Phone-farm management

| Control | Status | Where / how |
| --- | --- | --- |
| Select All / Deselect All | Existing | Devices sidebar: "Select all" / "Clear" |
| Group Control | Existing | Saved groups (Automate → Groups) as chips |
| Broadcast Input | Existing | Selected / Multi / All |
| Device Manager | Existing | Desk → Manage |
| Connect / Disconnect | Existing | Manage → Wireless: `adb pair`, `adb connect` and `adb disconnect`, plus QR pairing |
| Reconnect | Existing | Sidebar, Device actions (⋮) and the device menu. Offline phones get `adb reconnect`. |
| Restart Device | Existing | Reboot, with confirmation |
| Install APK | Existing | APK tool, Apps drop zone, device menu |
| Uninstall APK | Existing | Apps → Uninstall (`pm uninstall`) |
| File Transfer | Existing | Files panel: `adb push` / `pull`, browse, rename, delete |
| Sync Control | Existing (as fan-out) | Multi / All send one input to every target, and grid tiles mirror to the group. There is no master→follower mode, and none was added. |

## 3. Scrcpy screen and input

| Control | Status | Where / how |
| --- | --- | --- |
| Keyboard, Mouse / Cursor, Touch | Existing | Tools, toolbar, taskbar pins |
| Screen Rotation | **Added** | scrcpy `ROTATE_DEVICE` control message, op `rotate`. In More tools, the floating Tools "Screen" menu, and as a pin. Needs the live screen to be running. (**device**) |
| Fullscreen | **Added** | Browser fullscreen; Esc leaves. Separate from Fill window, which is unchanged. Hidden where the browser has no element fullscreen (iPhone Safari). |
| Stay Awake | **Added** | `svc power stayon true/false`. The state is read back from `stay_on_while_plugged_in`. It does not change Screen off. (**device**) |
| Screen Off | Existing | scrcpy `SET_DISPLAY_POWER`. Different from Power off (`reboot -p`). |
| Quiet mode (all phones) | **Added** | One toggle for every online phone, whatever Selected / Multi / All says: screens off (scrcpy `SET_DISPLAY_POWER`; the mirror keeps working) and each phone's media sound muted (`cmd media_session volume --stream 3`). Turning it off restores each phone's previous volume. In floating Tools, More tools, Settings, and as a pin. Screen off needs that phone's live screen to be running. (**device**) |
| Screenshot, Screen Recording | Existing | Use every control target |
| Quality Settings | Existing presets + **Custom added** | Each preset now shows its size, bitrate and FPS. Custom sends max size (0–4096, 0 = native), bitrate (0.25–40 Mbps) and FPS (5–120) to scrcpy-server, and the stream restarts. (**device**) |
| Clipboard Sync | Manual existing + **auto added** | "Sync clipboard" switch:<br>• Phone copies go to the PC clipboard.<br>• Ctrl/Cmd+V pastes the PC clipboard on the targets (scrcpy `SET_CLIPBOARD` with paste).<br>The browser must allow clipboard access (HTTPS or localhost); otherwise it says so and Ctrl+V goes through as a key. |
| Always on Top | **Added (view only)** | "Pop out": the live screen in the browser's picture-in-picture window, which stays on top. A page can't pin its own window, and the pop-out can't send input. |

## 4. Automation and macros (one engine: `src/lib/macro`)

| Control | Status | Where / how |
| --- | --- | --- |
| Macro, Run / Play, Stop | Existing | Macros panel and dock |
| Pause | **Added** | Pauses before the next step. Phones stay reserved, and time limits don't count paused time. Stop works while paused. |
| Record Macro | Existing | "Record touches" / "Replay touches" |
| Auto | Existing | The Automate section, Auto Clicker import/export, and Arrangement "Fit all" |
| Arrangement | Existing | Grid Arrangement strip |
| Import / Export Config | Existing | `.adboard-macros.json` and Auto Clicker |
| Loop | Existing | Forever / cycles / time limit |
| Task Queue | **Added** | Macros → Queue. Plays tabs in order through the same runner. A failed tab is noted and the queue moves on. Stop ends the queue. Saved as tab ids only. |
| Scheduler | **Added** | Macros → Schedule. Plays a tab or the queue once, or every N minutes. It runs only while an ADBoard page is open, because the agent has no macro runner. Slots missed while closed run once when the page is back. |

## iPhone Home Screen app

- **Installing:** iOS never shows an install prompt. Open the site in Safari, then Share → **Add to Home Screen** → keep **Open as Web App** on (iOS 26) → Add. Chrome/Edge on iOS 16.4+ have the same item in their Share menu. The item does not exist inside an already-installed Home Screen app, which has no browser bars. Settings → **Install on iPhone** shows these steps on iPhones.
- **Configuration:**
  - Manifest: `display: standalone`, `id`, `start_url` / `scope` "/". Served as `application/manifest+json` without sign-in.
  - Page: `apple-mobile-web-app-capable` with the black-translucent status bar, `viewport-fit=cover` and the theme colour.
  - Icon: an opaque 180×180 `apple-touch-icon.png`, also at the site root.
- **Bottom taskbar not responding in the Home Screen app (fixed).** Root cause: the floating Tools / Stats panels kept clear of the taskbar by a fixed 56 px reserve. In the Home Screen app the taskbar also sits above the home-indicator inset, so it is taller than that. A panel placed or dropped near the bottom then lay over the taskbar buttons and took their taps (reproduced in a simulated layout: Stats over Home, Recent, Minimize and the volume buttons). The panels now measure the taskbar itself, treat it as an obstacle, re-place when it changes size, and read safe-area insets from a probe element.
- **Touch diagnostics** (Settings → Control, or `?touchdebug=1`): marks each tap and shows which control received it, the events fired, and the viewport numbers iOS reports.

## 5. Floating UI and taskbar

Tools, taskbar customization, Stats, the Macro panel, Settings, Pin / Unpin, Collapse / Expand, Device Grid, Device Information, Device actions (⋮: Reconnect video, Restart ADB link, Power off; formerly "Quick actions"), and the Fill / Minimize layout controls already existed and are unchanged.

The new Rotate, Fullscreen and Pop out tools sit in a folding "Screen" menu in floating Tools, so the panel stays the same height until it is opened. Stay awake sits next to Screen off.

## Not verifiable here

- Real-phone behaviour of rotate, stay awake, custom bitrate / FPS and clipboard. The mock fleet returns mock results.
- Pop out of live video. Headless Chromium doesn't decode the H264 stream. The picture-in-picture method (canvas → video → PiP) was checked in Chromium on a drawn canvas.
- Fullscreen on iOS (hidden there).
- Schedules while no page is open (not supported).
- With several ADBoard pages open, each runs the scheduler. A due schedule could start twice if two pages reach it in the same moment.

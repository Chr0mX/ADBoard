# Shell Automation

**Shell Automation** (desk header → Shell Automation) builds and runs jobs made of app, device, file, key and touch steps on one or many phones. Finger-touch macros with exact timing and per-phone background runs live in [Macros](macros.md).

## Library

- **Saved jobs:** every job, grouped by folder. Only folders that hold jobs are shown. Each job has:
  - **Open** (in the Builder), **Duplicate**, **Rename**, **Export** and **Delete** (asks first)
  - **New job**, **Import** and **Export library**. Import reads an ADBoard script file (`.adboard-shell.json`), an older desk export or a single job file, by its contents, and adds to the library: a script already there is skipped and a name clash gets " 2". **Export** on a job saves `<Name>.adboard-shell.json`; **Export library** saves everything (touch macros, scripts, queue and schedules) as `adboard-library.json`.
- **Actions:** every action a job can use, grouped by category. Each card says what the action does and how it reaches the phone. **Add** puts it in the open job and switches to the Builder (with no job open, it creates one).

| Category | Actions |
|---|---|
| App Control | Launch app, Force stop app, Clear app data, Install APK, Uninstall app |
| Device Control | Shell command, Screenshot, Start / Stop screen recording, Reboot, Power off |
| Input Actions | Tap, Double tap, Long press, Swipe, Drag, Scroll, Pinch / zoom, Type text, Recorded touch |
| Navigation | Press key (Home, Back, Recent apps, Power, Volume) |
| Files | Send file to phone, Get file from phone, Delete file on phone |
| Delays | Wait |
| Flow Control | Wait for app, Wait for phone, Wait for live screen, Set wait time limit |

Every action maps to a real agent operation. There are no placeholders:

| Label | How it reaches the phone |
|---|---|
| **Shell** | An adb shell command on the phone: `am start`, `am force-stop`, `pm clear`, `pm uninstall`, `input text`, `screencap`, `screenrecord`, `rm` or your own command. Needs ADB. |
| **Touch** | A simulated finger through the agent's gesture endpoint, the same one the Macros runner uses. Uses scrcpy multi-touch when the live screen runs; a one-finger fallback via `adb shell input swipe` when it doesn't. |
| **Key** | An Android key over the control connection. |
| **File** | Moves a file between ADBoard's Files area and the phone. Needs ADB. |
| **Wait** | Waits on ADBoard; nothing is sent to the phone. |

**Recorded touch** is made with **Record touches** in Control and saved in the "Recorded" folder. It can't be added from the Library.

## Builder

- **Live preview** (left): the phone's live screen with the job's touch steps drawn on it.
  - Numbered markers for taps; arrows for swipes, drags, scrolls and pinches.
  - Pick the phone with the chips above it.
  - The frame keeps the phone's aspect ratio: the live video size when streaming, which follows rotation.
  - **Drag a marker**, or select a touch step, press **Set position** / **Set end** and click the screen. The step's X/Y fields update, and typing in the fields moves the marker.
  - Positions are percent of the phone's screen, which is exactly what the runner sends. A marker sits where the touch lands, on every phone size.
- **Steps** (right): each row shows its number, type, a Shell/Touch/Key/File/Wait label and its settings. Row controls:
  - ✓ turn the step on or off
  - ▶ test this one step on the preview phone
  - ↑ ↓ reorder, duplicate, delete
  - Click a row to edit its fields. Fields are checked as you type with the same rules the agent applies, and broken steps are outlined in red.
  - Every step can also **pause after** a number of milliseconds.
  - **Add** inserts a new step after the selected one.
- **Job settings:**
  - **Repeat job** plays the whole job N times.
  - **If a step fails** chooses between stopping that phone or noting the failure and going on.
- **Run:**
  - Tick phones (or add them by tag), then choose **At the same time** or **One after another**.
  - **Run** is blocked while a step needs fixing. Reboot and Power off ask first. **Stop** ends the run; waits stop at once.
  - Each phone shows its progress: step N of M, done, failed with the reason, skipped (offline) or stopped.
  - The **Log** lists every step result per phone, including command output and agent errors, with a **Failures only** filter.
  - Runs are saved to History.

## Errors and disconnects

- An offline phone is skipped when the run starts.
- A phone that disconnects during a run fails at its next step with "Phone disconnected". The other phones go on.
- Agent errors are shown as they are, for example "adb is not available", "package name is not valid", or a touch that failed.
- On the mock fleet, touches and keys report **"mock phone: not sent"** instead of claiming success.

## Limits

- Jobs run from the browser: keep the page open until the job ends. Touch macros that must keep going without a browser belong in Macros.
- Shell, File and Clear data / Uninstall steps need a real phone with ADB. The mock fleet returns "adb is not available".
- **Type text** can't type `; | & \` $ ( ) < > ' " \`. That's a limit of `input text`.
- Coordinate overrides per phone (Profiles) are applied when running, but there is no editor for them yet.

# Touch macros

**Macros** (desk header → Macros) replays taps, holds, swipes and multi-touch gestures on one or many phones. It reads Auto Clicker exports, and the older **Automate** panel stays as it was for app, file and shell steps.

## Virtual tabs

Each tab is a separate macro with its own data:

- reference screen
- scaling
- stop condition
- random offset
- steps
- target phones
- notes
- run state

Tabs are saved in this browser (`localStorage["adboard-macros"]`, up to 50).

- **New / Rename / Duplicate / Delete / ◀ ▶** manage tabs. Double-click a tab to rename it. A duplicate gets fresh ids, so editing it never touches the original.
- Switching tabs keeps each tab's selected step and preview screen.
- Several tabs can run at once. A phone belongs to one running tab at a time. Another tab that targets it marks it **busy** and skips it, so two macros never fight over one screen.

## Steps

A step is 1–10 fingers played together, then a wait.

| Field | Meaning |
|---|---|
| X / Y | Where the finger goes down, in reference-screen pixels |
| Swipe → To X / To Y | Where it lifts; the finger moves in a straight line |
| Press / swipe time | How long the finger stays down (10 ms – 60 s) |
| Starts after | Multi-touch only: delay for this finger from the step start, so fingers can overlap |
| Then wait | Pause after the step, before the next one |

**Add** has quick presets: Tap, Hold, Swipe, 2-finger tap, Pinch. **Add finger** turns any step into multi-touch. ▶ on a step plays just that step once on the tab's phones.

## Live view

- **Macros → Preview → Show on** a phone draws the touch markers over that phone's **live screen**. The frame follows the real video size, so it follows rotation too. A badge shows *Live*, *Waiting for picture…*, *Connecting…* or *Video unavailable*. Untick **Live** to edit without streaming. A tab opens on its first target phone.
- While a tab runs, each touch flashes as a fading ring on the live preview and on the main Control screen.

## Macros in Control

**Macros** in the Control tool row (and in the grid bar) opens a Macros panel on the right. It replaces Devices until closed. On phones it opens from the floating controls as a full-screen sheet. The panel has:

- **Macro tab** picker (● = running)
- **Run on:** *Control targets* (whatever Selected / Multi / All points at, the default) or *Tab's phones*
- **Run / Stop** and the live status (cycle, step, touches, each phone)
- a live preview of the active phone with the tab's markers and touch rings
- the steps, each with ▶ Test
- **Edit in Macros**, which opens the full editor

## Running

The agent plays each step (`POST /api/input/gesture`) on all of a tab's phones at once. It times touch-down, moves and release on its own clock.

- Each finger uses its own scrcpy pointer id (0–9). Android sees real multi-touch (`ACTION_POINTER_DOWN`/`UP`).
- Every finger that went down is lifted, even if a write fails part-way or the browser disconnects mid-gesture. The gesture runs on its own task.
- One gesture runs at a time per phone. Gestures from different tabs or browsers queue instead of mixing finger slots.
- With no live screen, a one-finger step falls back to `adb shell input swipe`. Multi-touch needs the scrcpy session, which the agent starts if needed.
- A phone that fails drops out of the run and the rest continue. **Stop** waits for the gesture in flight, which always finishes with its fingers lifted.

**Repeat** sits next to the Run button, in the Macros editor and in the Control panel:

- **Loop forever:** plays all enabled steps over and over until you press Stop. The status shows `cycle N · ∞ until stopped`.
- **Cycles:** plays all enabled steps that many times.
- **For time:** repeats until the time is up.

The Run button says what will happen ("Run forever on 3 phones", "Run ×10 …", "Run for 5 min …"). The setting is locked while the tab runs.

**Random offset** moves each touch by up to N reference pixels, like Auto Clicker's anti-detection.

## Resolution scaling

Positions are stored in the tab's **reference screen**, the resolution the macro was written for. They are scaled to each phone when it runs.

- **Stretch** (default): same relative spot on every screen (x / width, y / height).
- **Keep aspect:** the reference screen is scaled uniformly and centered (letterboxed) on screens with another shape. Phones with different sizes get separate requests.
- **Other orientation:** *Run anyway* (default) or *Skip phone*. The check uses the phone's reported size (`wm size`), which is its natural orientation, not the current rotation.
- Changing the reference resolution with **Move touches with the resolution** ticked rescales every point, so touches stay on the same spot.
- **Preview → Show on** draws the touches on the reference screen or on any phone's screen size, scaled exactly as the run will scale them. Drag a marker to move it. Arrow keys nudge by 1 px, Shift + arrow by 10 px. **Click to add** drops a tap where you click.

## Import / export

**Export** offers this tab, all tabs, or Auto Clicker format. **Import** accepts:

| File | Notes |
|---|---|
| ADBoard macros (`"format": "adboard-macros"`) | Full fidelity. Bad values are repaired with a note; newer format versions are refused |
| Auto Clicker config (`config.txt`, JSON array) | Each configuration becomes a tab. Auto Clicker does not store the screen size, so the dialog guesses one from the furthest point (for example 900×1600) and lets you pick a preset or a connected phone's size |
| Older ADBoard Automate macro or desk export | Tap / double tap / long press / swipe / scroll / drag / pinch / recorded gesture / wait are converted from percent coordinates. App, file and shell steps stay in Automate |

The dialog shows what will be imported and any notes before anything is saved. **Add as new tabs** or **Replace all tabs** decides where it goes. Corrupt JSON, empty files and unknown files are refused with a reason, and the saved tabs are left as they are.

### Auto Clicker mapping

| Auto Clicker | ADBoard |
|---|---|
| `targets[]` | steps, in order |
| `type` 0 (click) | 1 finger, 10 ms |
| `type` 1 (swipe) `xPos,yPos → xPos1,yPos1`, `duration` (0 = 500 ms) | 1 finger swipe |
| `delayValue` × `delayUnit` (0 ms, 1 s, 2 min) | Then wait |
| `stopConditionChecked` 0 / 1 / 2 | When stopped / After time (`timeValue` s) / After cycles (`numberOfCycles`) |
| `antiDetection` | Random offset 12 px |

Exporting back to Auto Clicker writes the same structure. A multi-touch step becomes one target per finger, because Auto Clicker plays one target at a time. An imported Auto Clicker file exports back unchanged.

## Limits

- Tabs live in the browser that made them. Use Export / Import to move them to another browser or machine.
- Multi-touch and exact timing need the live scrcpy session. The ADB fallback covers one finger only.
- The orientation check in runs uses the phone's reported size. The live preview warns using the real video size.
- Live video needs a browser with H.264 WebCodecs (Chrome, Edge, Safari). Headless test browsers show the markers without the picture.
- Mock fleet (`PHONECONTROL_FORCE_MOCK=1`): gestures keep their timing and report *Mock (not sent)*.

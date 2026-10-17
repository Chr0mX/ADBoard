# Touch macros

**Touch Macros** (desk header → Touch Macros) replays taps, holds, swipes and multi-touch gestures on one or many phones. It reads Auto Clicker exports.

Don't confuse it with **Shell Automation** (desk header → Shell Automation), the older panel for app, file and shell-command jobs (launch or stop apps, install APKs, move files, run `adb shell` commands). Touch Macros are finger touches played by ADBoard with exact timing on the agent; Shell Automation jobs run from the browser.

## Virtual tabs

Each tab is a separate macro with its own data:

- reference screen
- scaling
- stop condition
- random offset
- steps
- target phones
- notes

Tabs are kept on ADBoard (`adboard-data/macros.json` next to the executable) and shared by every browser that opens this ADBoard. Each browser keeps a copy in `localStorage["adboard-macros"]` (up to 50 tabs) and uses it when ADBoard can't be reached. See [Sharing and versions](#sharing-and-versions).

- **New / Rename / Duplicate / Delete / ◀ ▶** manage tabs. Double-click a tab to rename it. A duplicate gets fresh ids, so editing it never touches the original.
- Switching tabs keeps each tab's selected step and preview screen.
- Several tabs can run at once, and different phones can run different tabs. A phone runs one macro at a time: a tab that targets a busy phone marks it **busy** and skips it, so two macros never fight over one screen.

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

- **Touch Macros → Preview** has a row of phone chips (name, online dot; "in Control" marks the phone you are controlling) and a **Reference** chip. Tap a phone to draw the touch markers over its **live screen**; Reference shows the blank reference frame. The frame follows the real video size, so it follows rotation too. A badge shows *Live*, *Waiting for picture…*, *Connecting…* or *Video unavailable*. Untick **Live** to edit without streaming.
- The preview opens on the phone you are controlling, else the first online ticked phone, else any online phone. Each tab remembers the last chip you picked.
- While a tab runs, each touch flashes as a fading ring on the live preview and on the main Control screen.

## Macros in Control

**Touch Macro** in the Control tool row (and in the grid bar) opens a Touch Macros panel on the right. It replaces Devices until closed. On phones it opens from the floating controls as a full-screen sheet.

Opened while a phone is selected, the panel belongs to **that phone**. Selecting another phone switches the panel to it. It has:

- **Macro for S23:** the phone's own macro (its saved choice). Changing it changes only this phone. The Macros page, other phones and other browsers stay where they are.
- **Run on:** *This phone* (the default), *Control targets* (whatever Selected / Multi / All points at) or *Tab's phones*
- **Start / Pause / Stop** for this phone alone, with its live status (cycle, step, touches). With the other two choices, Run / Stop act on the tab's phones as before.
- the phone's live screen with the macro's markers and touch rings
- the steps, each with ▶ Test (this phone only in *This phone* mode)
- the **Phones** card
- **Edit in Touch Macros**, which opens the full editor on this phone's macro and live screen

With no phone selected, the panel works on the shared tab and the Control targets.

## Phones: a macro per phone

**Touch Macros → Phones** (also in the Control panel) lists every connected phone. For each phone you can:

- pick its macro; the choice is saved on ADBoard (`adboard-data/macro-assignments.json`), so it survives refreshes, reconnects and restarts
- **Start**, **Pause** / **Resume** and **Stop** it
- watch its live status: macro, cycle, step, touches and the last message

**Start all** starts every online phone that has a macro and isn't running; **Stop all** stops every run.

Each phone's run is independent:

- S24 can play "Farm" while S23 plays "Collect", each with its own cycles and stop condition.
- Stopping, pausing or failing one phone doesn't affect the others.
- A phone has one run at a time. A second Start on a busy phone is refused and says which macro it is running.
- Before every step the run checks that its phone is still connected. If it isn't, only that phone's run ends, with "Phone disconnected", and the phone is freed.
- Offline phones can't be started.

The tab **Run** button still works: it starts one run per ticked phone, skips busy or offline phones and lists them in the status, and **Stop** stops every phone running that tab.

## Running

Runs live in ADBoard (the agent), not in the browser. A run keeps going when the browser that started it closes, and every open browser sees it live and can pause or stop it. Runs end when ADBoard itself is closed. Phone choices are kept, but runs have to be started again.

The agent plays each step through the same path as `POST /api/input/gesture`. It times touch-down, moves and release on its own clock.

- Each finger uses its own scrcpy pointer id (0–9). Android sees real multi-touch (`ACTION_POINTER_DOWN`/`UP`).
- Every finger that went down is lifted, even if a write fails part-way or the browser disconnects mid-gesture. The gesture runs on its own task.
- One gesture runs at a time per phone. Gestures from different tabs or browsers queue instead of mixing finger slots.
- With no live screen, a one-finger step falls back to `adb shell input swipe`. Multi-touch needs the scrcpy session, which the agent starts if needed.
- A phone that fails ends its own run and the rest continue. **Stop** waits for the gesture in flight, which always finishes with its fingers lifted.

Agent API (the UI uses these; all need the session token):

| Route | Does |
|---|---|
| `GET /api/macro/runs` | Every phone's live run (or last result), paused phones, queue progress |
| `POST /api/macro/runs` `{tab, deviceIds, onlyStepId?}` | Play a tab: one run per phone. Returns `started` and `skipped` |
| `POST /api/macro/runs/{tabId}/stop\|pause\|resume\|forget` | Act on every phone running that tab |
| `POST /api/macro/devices/{deviceId}/start` `{tab? \| tabId?}` | Start one phone. No body plays its saved choice. 409 if it is busy, 400 if offline |
| `POST /api/macro/devices/{deviceId}/stop\|pause\|resume` | Act on one phone only |

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
| Older ADBoard Shell Automation macro or desk export | Tap / double tap / long press / swipe / scroll / drag / pinch / recorded gesture / wait are converted from percent coordinates. App, file and shell steps stay in Automate |

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

## Sharing and versions

Macros, the queue, schedules and phone choices are shared through ADBoard (`/api/store/{name}`). Writes carry a revision number, so a stale browser never overwrites a newer copy.

- When a browser's copy and ADBoard's differ, both are kept. Tabs are joined by id, and for the same tab the newer edit wins.
- A browser that only holds the empty starter tab never uploads it over real macros.
- Before a shared copy replaces a browser's own, that browser keeps a backup (the last 5).
- ADBoard keeps the last 20 saved copies in `adboard-data/history/`.
- **Versions** (next to Import / Export) lists both. **Restore** puts one back; a restore is itself a new version, so it can be undone.

Macros lost before this protection existed were browser data, not code. Bring them back with **Import** from a saved `.adboard-macros.json` or Auto Clicker file.

## Limits

- Use Export / Import to move macros to a different ADBoard.
- Macros don't run while ADBoard is closed.
- A real cable unplug mid-run is detected by the connection check before each step. Tests simulate it; check it on real phones.
- Multi-touch and exact timing need the live scrcpy session. The ADB fallback covers one finger only.
- The orientation check in runs uses the phone's reported size. The live preview warns using the real video size.
- Live video needs a browser with H.264 WebCodecs (Chrome, Edge, Safari). Headless test browsers show the markers without the picture.
- Mock fleet (`PHONECONTROL_FORCE_MOCK=1`): gestures keep their timing and report *Mock (not sent)*.

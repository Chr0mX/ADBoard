# Touch macros

**Macros** (desk header → Macros) replays taps, holds, swipes and multi-touch gestures on one or many phones. It reads Auto Clicker exports.

Don't confuse it with **Shell Automation** (desk header → Shell Automation), the older panel for app, file and shell-command jobs (launch or stop apps, install APKs, move files, run `adb shell` commands). Macros are finger touches played by ADBoard with exact timing on the agent; Shell Automation jobs run from the browser.

## Virtual tabs

Each tab is a separate macro with its own data:

- reference screen
- scaling
- stop condition
- random offset
- steps
- target phones
- notes

Each tab is kept on ADBoard as its own file, `<Name>.json` in the `macros` folder of the data folder (`%LOCALAPPDATA%\ADBoard`; see [storage.md](storage.md)) and shared by every browser that opens this ADBoard. Each browser keeps a copy in `localStorage["adboard-macros"]` (up to 50 tabs) and uses it when ADBoard can't be reached. See [Sharing and versions](#sharing-and-versions).

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

**Add** has quick presets: Tap, Hold, Swipe, 2-finger tap, Pinch, and the text steps below. **Add finger** turns any step into multi-touch. ▶ on a step plays just that step once on the tab's phones.

## Text steps (OCR)

A text step reads the phone's screen instead of touching a fixed point, so a macro can react to what the app shows: wait for a login screen, tap **Sign in** wherever it is, branch when **Wrong password** shows up.

| Do | Succeeds when | Default if it doesn't |
|---|---|---|
| **Tap text** | the text is found; it is tapped at its center (plus **Offset X / Y**) | fail the run after 10 s |
| **Wait for text** | the text shows | fail the run after 30 s |
| **Wait until gone** | the text is not on screen (loading spinners, "Please wait") | fail the run after 30 s |
| **If text is shown** | the text is on screen (looks once) | next step |
| **Read text** | the text is found, or anything is in the area when **Text** is empty; it is stored in **Store in** | next step |

Each step has:

| Field | Meaning |
|---|---|
| Text | One per line; any of them matches. `{name}` puts in a value a Read step stored |
| Match | **Contains** (anywhere in a line), **Exact words** (whole words: "OK" matches "Cancel OK", not "Bookmark") or **Regex**. A Read step with a regex stores its first group, e.g. `Coins: (\d+)` → `1250` |
| Match case | Off by default |
| Keep looking for / Wait up to | How long to keep reading the screen; 0 looks once. Up to 10 min |
| Look every | Time between reads (250 ms – 60 s) |
| Look only in an area | X, Y, width, height in reference pixels, scaled to each phone like touches. Text outside is ignored, and a smaller area reads faster |
| When found / If not found … | **Next step**, **Go to step N**, **End the run (done)** or **Fail the run**. The labels follow the action (After tapping, If still shown…) |
| Then wait | Pause after the step, as for touches |

**Go to step** is how a macro branches and loops: a check that jumps back to an earlier step repeats until the screen changes. A jump to a step that was turned off or deleted fails the run with that reason. Jumps don't count as cycles; the tab's **Repeat** setting still ends the run.

**Read screen** in the step editor reads the previewed phone (or the first ticked online phone) now. The Preview draws a box round every line it read, green for lines the step's text matches, and lists the lines; tap one to look for it. The step's area is drawn dashed. While a run waits on a text step, the run status shows the step, the number of reads, what it saw and how long a read took, plus the values Read steps stored. While a run is on a text step that found its text, the text is outlined in green on the live preview.

### How it reads

- The agent takes a screenshot over ADB (`screencap`, as the Screenshot tool does), crops it to the area and recognizes the text on the ADBoard computer with [ocrs](https://github.com/robertknight/ocrs): offline, CPU only, no extra program to install. A full 1080×2400 screen takes about half a second on a 4-core PC; an area is faster.
- Boxes are 0–1 of the screen in its current rotation, the same space touches use, so a found text is tapped in the right place on any resolution, density or orientation.
- One recognition runs at a time (it already uses every core); phones queue for it. A screen that has not changed since that phone's last read reuses that read's text instead of recognizing it again.
- **Stop** ends a wait at once, even in the middle of a read. **Pause** holds a wait too, and paused time does not count against its timeout or the tab's time limit.
- The connection check runs before every read. An unplugged phone ends its own run with "Phone disconnected". Up to 3 failed screenshots in a row are retried; then the step fails with the reason.
- Several phones running the same tab each read their own screen and branch on their own: runs are per phone.
- Phones on another host are read by that host (its ADB and models).

### Setup

The two model files (12 MB) are not part of the source or the build. `make fetch-deps` (Windows: `scripts\fetch-deps.ps1`) downloads them, checks their checksums and puts them in `tools/ocr/` (Linux) and `dist/windows/vendor/ocr/` (Windows pack). To keep them elsewhere, set `ADBOARD_OCR_MODELS` to their folder. Without them, text steps fail with a note that says how to install them, and the step editor shows the same note. Touch steps never need them.

The models read Latin letters, digits and common punctuation (English and most Western languages without accents). Text in other scripts, very small text and stylized game fonts may not be read; try **Read screen** first, and prefer **Contains** with a short, distinctive part of the text.

The mock fleet (`ADBOARD_FORCE_MOCK=1`) has no screens: every mock phone "shows" the same sample lines (Settings, Wi-Fi Connected, Sign in, Continue, Cancel OK…), so text steps can be tried without phones.

### Adding another engine

`crates/adboard-agent/src/ocr.rs` has a small `TextEngine` trait (`recognize(image) → lines with boxes`). The capture, cropping, caching and matching around it, and the macro runner, don't depend on the engine, so another engine or other models only need a new implementation of that trait. Lines carry an optional confidence for engines that report one (ocrs does not).

## Live view

- **Macros → Preview** has a row of phone chips (name, online dot; "in Control" marks the phone you are controlling) and a **Reference** chip. Tap a phone to draw the touch markers over its **live screen**; Reference shows the blank reference frame. The frame follows the real video size, so it follows rotation too. A badge shows *Live*, *Waiting for picture…*, *Connecting…* or *Video unavailable*. Untick **Live** to edit without streaming.
- The preview opens on the phone you are controlling, else the first online ticked phone, else any online phone. Each tab remembers the last chip you picked.
- While a tab runs, each touch flashes as a fading ring on the live preview and on the main Control screen.

## Macros in Control

**Macro** in the Control tool row (and in the grid bar) opens a Macros panel on the right. It replaces Devices until closed. On phones it opens from the floating controls as a full-screen sheet.

Opened while a phone is selected, the panel belongs to **that phone**. Selecting another phone switches the panel to it. It has:

- **Macro for S23:** the phone's own macro (its saved choice). Changing it changes only this phone. The Macros page, other phones and other browsers stay where they are.
- **Run on:** *This phone* (the default), *Control targets* (whatever Selected / Multi / All points at) or *Tab's phones*
- **Start / Pause / Stop** for this phone alone, with its live status (cycle, step, touches). With the other two choices, Run / Stop act on the tab's phones as before.
- the phone's live screen with the macro's markers and touch rings
- the steps, each with ▶ Test (this phone only in *This phone* mode)
- the **Phones** card
- **Edit in Macros**, which opens the full editor on this phone's macro and live screen

With no phone selected, the panel works on the shared tab and the Control targets.

## Phones: a macro per phone

**Macros → Phones** (also in the Control panel) lists every connected phone. For each phone you can:

- pick its macro; the choice is saved on ADBoard (`config\macro_assignments.json` in the data folder), so it survives refreshes, reconnects and restarts
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
| `GET /api/ocr/status` | Whether text steps can read screens (models found) |
| `POST /api/ocr/read` `{deviceId, area?, query?}` | The text on a phone's screen now, as lines with 0–1 boxes, and the query's matches |

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

**Export** offers this tab (`<Name>.json`), all tabs (`adboard-macros.json`), or Auto Clicker format. Chrome and Edge ask where to save it; other browsers download it. The whole library, including Shell Automation, is exported from Settings → Data & storage as `adboard-library.json`. **Import** accepts:

| File | Notes |
|---|---|
| ADBoard macros (`"format": "adboard-macros"`) | Full fidelity. Bad values are repaired with a note; newer format versions are refused. Files with text steps are format 2; files with only touches are still written as format 1, so older ADBoards read them |
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

Exporting back to Auto Clicker writes the same structure. A multi-touch step becomes one target per finger, because Auto Clicker plays one target at a time. Text steps are left out, with a note. An imported Auto Clicker file exports back unchanged.

## Sharing and versions

Macros, the queue, schedules and phone choices are shared through ADBoard (`/api/store/{name}`). Writes carry a revision number, so a stale browser never overwrites a newer copy.

- When a browser's copy and ADBoard's differ, both are kept. Tabs are joined by id, and for the same tab the newer edit wins.
- A browser that only holds the empty starter tab never uploads it over real macros.
- Before a shared copy replaces a browser's own, that browser keeps a backup (the last 5).
- ADBoard keeps the last 20 saved copies in `backups\history` in the data folder.
- **Versions** (next to Import / Export) lists both. **Restore** puts one back; a restore is itself a new version, so it can be undone.

Macros lost before this protection existed were browser data, not code. Bring them back with **Import** from a saved `.json` (or older `.adboard-macros.json`) or Auto Clicker file.

## Limits

- Use Export / Import to move macros to a different ADBoard.
- Macros don't run while ADBoard is closed.
- A real cable unplug mid-run is detected by the connection check before each step. Tests simulate it; check it on real phones.
- Multi-touch and exact timing need the live scrcpy session. The ADB fallback covers one finger only.
- The orientation check in runs uses the phone's reported size. The live preview warns using the real video size.
- Live video needs a browser with H.264 WebCodecs (Chrome, Edge, Safari). Headless test browsers show the markers without the picture.
- Mock fleet (`ADBOARD_FORCE_MOCK=1`): gestures keep their timing and report *Mock (not sent)*.
- Text steps run on the agent only. Without an agent (the in-browser preview), a run stops at the first text step and says so.
- Text steps read with a screenshot each time (about 0.2–1 s per read, more over Wi-Fi ADB). For text that changes many times a second, use a touch step with a delay.

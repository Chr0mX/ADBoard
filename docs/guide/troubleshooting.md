# Troubleshooting

Back to the [guide index](README.md).

## No phone appears

1. Check that **USB debugging** is on (see [Getting started](getting-started.md)) and the cable carries data, not only power. Try another cable or port.
2. Look at the phone: accept the **Allow USB debugging?** prompt. A phone that hasn't accepted it shows **unauthorized** in ADBoard, with the hint to unlock USB debugging. Accept the prompt, then press **Reconnect**.
3. Open **Manage → Actions** with the phone ticked and press **Reconnect**, then **Restart ADB** if it still doesn't show.
4. Make sure no other program (another ADB, an emulator tool) is holding the phone.
5. On the PC, check that `vendor\adb\adb.exe` exists. Without ADB, ADBoard can't see real phones.

## A phone shows "offline"

The PC can't reach it: reconnect the cable or Wi-Fi, then **Reconnect**. For a Wi-Fi phone, pair it again in **Manage → Wireless**. Offline phones are skipped when you run macros or scripts.

## The screen is black, frozen or says "recovering"

Press **Refresh** under the phone, or **Reconnect** in the Devices column. The stream restarts. If the picture never appears, check that your browser supports H.264 video (Chrome, Edge, Safari). Some headless or locked-down browsers can't show it.

**A phone whose stream failed to start tries again by itself.** If the screen shows a stream error (the agent log says `scrcpy raw capture failed`), ADBoard retries the start while the phone is online and a page is showing it: after 3 s, then 6, 12 and 24 s, and every 30 s after that. Each retry first ends a scrcpy server an earlier run may have left on the phone, and the log says `retrying the start of a phone's stream` with the attempt number. You do not need to reload the page. If it never recovers, send the log lines around `scrcpy raw capture failed`.

**Every screen frozen right after the page loads, fixed by a refresh.** Two causes are handled now. The page used to ignore video until its first keyframe request answered, and that request could hang for good (all six of the browser's connections to ADBoard busy at load, or no answer from the agent). The page now accepts video at once (the agent itself holds back what cannot be shown yet), and the request gives up after 3 s. On a LAN address (`http://192.168...`) the browser plays through a hidden video element instead of WebCodecs, and an element that paused or stalled was not noticed: it is now started again, then rebuilt if that does not help.

**Every phone freezes after a few seconds of controlling.** A finger drag sends a stream of moves. Before, every one was queued and sent in turn, both in the page and on the phone's scrcpy control socket. A keyframe request (what a frozen picture needs) waited behind them, and a phone that read slowly made it wait for seconds. Now the page and the agent send only the newest move when they are behind; a down, an up and the last move before a release always arrive, in order. Keyframe requests go ahead of everything on the control socket. If a phone still reads too slowly, the agent log says `scrcpy control socket is backed up` with how long the message waited.

**What the page saw goes into the agent log.** When a page sees a video problem (pictures arriving but none shown, a request that did not answer, a stalled player, a closed socket, a decoder rebuilt), it sends the agent one report per phone and kind of problem every 15 s at most. The agent logs it as `page reports a video problem` with the stage states first. Sending the agent log is then enough to see both sides.

To see where a frozen picture is held, open the page with `?perf=1` and run `JSON.stringify(__adboardPerf.snapshot(), null, 1)` in the console. Each phone has a `pipeline` entry: `socket`, `acceptingVideo` and `connectRefreshPendingMs` (the page still waiting for its first keyframe request), `path` (`webcodecs` or `mse`), `decoder`, `decodeQueue`, `sawKeyframe`, `gateDropping`, and for `mse` the video element's `readyState`, `paused`, `currentTime`, `bufferedEnd` and `behindMs`. The counters `connectRefreshTimeouts` and `mseNudges` say how often each fix was needed.

**Keyframe requests.** The agent log line `keyframe request storm` means one phone was asked for a new keyframe four or more times in ten seconds. Each request restarts that phone's encoder and sends a large picture, so the agent slows to one every 4 s and the line names who asked (for example `decode-backlog x5`: this computer's decoder cannot keep up, so lower the quality or the number of phones in the grid). The page shows the same counts in `__adboardPerf.snapshot()` as `keyframeAsksBy` when opened with `?perf=1`, together with `backlogEpisodes` (how often this computer's decoder fell behind) and `maxQueue`.

## Taps or typing don't reach the phone

- Make sure **Touch** (and, for typing, **Keyboard**) is switched on under the phone.
- Check who is being controlled: **Selected** sends to one phone, **Multi** to the ticked phones, **All** to every online phone.

## A macro does nothing

- Tick at least one online phone under **Phones for this tab** in the Run card.
- Check the macro has an enabled step, and that its X and Y are inside the reference screen.
- A phone runs one macro at a time; a busy phone is skipped, and the status says which macro it is running.
- Macros stop when ADBoard itself is closed.

## A script step fails

Open the **Log** in the Builder. The reason from the phone or ADBoard is shown as reported, for example "adb is not available" or "package name is not valid". Steps that use ADB (shell commands, files, install, uninstall) need a phone connected with ADB. Steps that need fixing are outlined in orange, and **Run** is blocked until they are fixed.

## An app button has no icon

The first time, the phone must be connected so ADBoard can read the app's icon, which it then keeps. A coloured letter shows until then, and it stays if the icon can't be read. You can type an icon in the app's edit form to use your own.

## Something I made is gone, or two copies exist

Nothing is deleted without being kept: look in the `backups` folder of the data folder (the **Storage** tab shows its path). **Macros → Versions** restores an earlier copy of your macros. See [Your files and backups](../storage.md).

## I forgot my password

Start ADBoard once with `ADBOARD_PASSWORD` set to a new password and `ADBOARD_RESET_PASSWORD=1`. See [Remote access](../remote-access.md).

## A virtual display won't start

The message under **Add virtual display** says why:

- **"Android API … is too old"**: virtual displays need Android 13 or newer.
- **"scrcpy-server … is too old"**: they need scrcpy 3.0 or newer. Run `fetch-deps` again (set `SCRCPY_VERSION` to pin a version) and restart ADBoard.
- **"already has 1 virtual display(s)"**: the phone is at its limit. Close one, or raise **Displays per phone** in [Settings](settings.md#virtual-displays).
- **"not a phone on this computer"**: a phone plugged into another computer has to get its display from that computer's ADBoard.
- **"is not online"**: the phone must show as online first.

If the display starts but an app won't open on it, or shows black, that app may not support a second screen. Try another app, or start it from the display's menu with its full `package/.Activity` name.

## Still stuck

The file `logs\adboard.log` in the data folder records what ADBoard did. **Developer → Logs** shows a phone's own log.

## "Cannot reach the ADBoard agent"

The page lost contact with the ADBoard program. It keeps showing the phones it knew about, but any that were online are shown as unreachable (the "online" count drops to 0) and their controls stay off, because the last answer is old. It keeps trying and comes back by itself when the program answers again, and the line disappears. If it does not, check that ADBoard is still running on the PC (`http://<the PC>:3848/health` should answer) and that the address has not changed.

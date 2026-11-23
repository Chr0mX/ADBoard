# UI audit (reliability and completeness)

Findings from a read-only audit of the desktop app (`/`) and the phone app (`/m/`), the backend routes and their UI, with what was fixed and what is left. Evidence is from reading the code; the checks that were run are listed in the change notes.

## Fixed in this round

| Was | Now |
|---|---|
| A failed device request replaced the real fleet with sample phones, all "online" (`use-adboard.ts`) | Sample phones only in demo mode (no agent configured). A real list is kept, its online phones show as stale, a banner says when it was last confirmed, and the page retries and recovers by itself. Out-of-order answers are dropped. |
| Quiet Mode showed ON even when every call failed | The switch changes only if at least one phone really went quiet; the note says what failed. |
| Quality, Audio and Screen-off switches stayed in a state no phone took | They roll back when no phone accepted the change. |
| Size select changed every online phone from a plain change event | Asks first (it changes all online phones, not only the targets), and remembers the choice only if a phone took it. |
| Files: PC and phone Delete ran at once; failures were silent | Confirmation, and errors are shown. Phone-pane "Download" (it copies to the PC's Downloads) is now "Save to PC". |
| Apps: Force Stop, Uninstall and App delete ran at once on all ticked phones; package field pre-filled `com.example.app` | Confirmation for each; the buttons stay off until a phone is ticked and a package typed, with a line saying so; errors are shown (desktop and phone app). |
| Manage recovery buttons and Developer shell were fire-and-forget or silent with no phone ticked | Results and "tick a phone" messages are shown. |
| Back / Home / Recent failures were invisible | The failure is shown. |
| Sync clipboard pasted on the phones from any tab | Only on Control screens. |
| Settings text said Stream and Quiet Mode act on the target phones | They say Screen size and Quiet Mode change every online phone. |

## Still open

### P0 (broken, misleading or unsafe)
1. **No way to type on the phone app (`/m/`).** Keyboard injection listens to `window` key events only; the Keyboard tool and Settings switch promise it. Needs an on-screen text input (frontend).
2. **Control mode "All" is a synced preference and nothing shows it.** A second browser starts in All, and Fill window hides the Devices panel that holds the mode. Needs a visible "controlling N phones" indicator and a thought about syncing it (frontend, maybe a pref change).
3. **Shell Automation runs Uninstall, Clear data, Force stop, Delete file and Shell steps on all phones without a prompt** (only reboot and shutdown are flagged dangerous, `lib/desk/actions.ts`).
4. **Macros "Match phones to W×H" changes resolution and density with no confirmation**, and the Size select, that button and virtual-display defaults are three unrelated controls for display size.

### P1
- Reconnect / Restart ADB run on all targets with no confirmation (stage quick actions, `DeviceMenu`, `MultiDeviceToolbar`) under five different labels.
- `DeviceMenu` items named like actions (Uninstall APK, Force Stop App, Clear App Data) only open another tab.
- Target selection is separate on Manage, Apps, Files, Developer, Shell Automation and Macros (each starts from the Control targets, then diverges).
- Virtual display Close / Close all, Wireless Remove, Macros version restore, Storage "Use this folder" and Discord "Remove webhook" have no confirmation.
- Stay awake OFF failure shows OFF while the phone is still awake; Control's Rec/Stop state is React-only and unaware of Manage's Record.
- The phone app's BottomSheet is not a real modal (no focus trap) and only the Phones sheet is a history entry, so Android Back leaves the page from the others. The taskbar is customised in four places.
- 36 px touch targets on Control (phone strip chips, floating-panel buttons) and hover-only (`title`) explanations on touch.

### P2 / P3
- Per-device settings (quality, audio, screen-off, stay awake) are global preferences applied to the targets; there is no per-device override or "exclude from bulk actions".
- Touch toggle is not persisted and has no Settings control. Taskbar tool pins, edge-tab style and virtual-display defaults are local to one browser or tab.
- Backend without UI: `copy` and `push` ops (dead), `tap`/`swipe`/`longPress` on the command endpoint (UI uses `/api/input/*`), session start/stop/restart routes, the `text` op only through Shell Automation, App-controls ops only on desktop, agent-wide environment settings. Undocumented routes: audio WebSocket, `/ws/events`, input text/key/refresh/clipboard/install, push and uploads, host files, macro queue, wireless QR, account password and logout.
- Accessibility: pointer-only phone stage, menus without arrow keys or focus return, radio buttons without arrow keys, repeated row buttons with no item name.
- Features worth a later phase: configurable connection alerts (cooldown, quiet hours, sound, desktop notifications), per-host recovery visibility, sort/group/filter of phones, panel position persistence, interface density, per-setting reset.

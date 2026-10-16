# Phone-control buttons: audit checklist

Status of every control requested in the buttons audit. "Existing" controls were
left as they were; "Added" ones are new. Verified against the mock fleet
(`PHONECONTROL_FORCE_MOCK=1`) in the browser at desktop and phone widths; items
marked **device** still need a check on real phones.

## Bottom taskbar (phone layout)

| Control | Status | Notes |
| --- | --- | --- |
| Back / Home / Recent | Existing | Android keys |
| Minimize | Added | Folds every floating panel (Tools, Stats) to its chip. Android has no "minimize" key. |
| Vol− / Vol+ / Power | Existing | Android keys |
| Pinned tools | Existing + 5 added | Cursor, Restart device, Device info, Arrangement, Quick actions can be pinned (limit 15) |

## Floating Tools

| Control | Status | Notes |
| --- | --- | --- |
| Keyboard, Touch, Record / Play, Refresh, Screenshot, Screen record, Install APK, Grid, Stats mode, Devices | Existing | Unchanged |
| Cursor | Added | Sends clicks and taps as a mouse so Android shows a pointer (**device**) |
| Restart device | Added | Confirms first; with several targets the phrase "restart" is required (**device**) |
| Device information | Added | Opens Manage → Info for the active phone |
| Arrangement | Added | Opens the grid (if needed) and its Arrangement strip |
| Quick actions | Added | Reconnect video, Restart ADB link, Power off (confirmed) (**device**) |
| Macro, window controls (collapse, pin, edge dock) | Existing | Unchanged |

The same Cursor / Restart / Info / Arrangement / Quick actions are in the
desktop "More tools" popover.

## Panels

| Panel | Status | Notes |
| --- | --- | --- |
| Stats: FPS, bitrate, battery, temperature | Existing | |
| Stats: CPU, memory | Added | Agent reads `/proc/stat` and `/proc/meminfo` with the battery poll. CPU appears from the second poll (about 15 s). Shows "—" when the phone does not expose them (**device**). |
| Macro | Existing | |
| Settings | Added | Desk → Settings: stream options, keyboard, cursor mode, stats mode, grid arrangement and bar, taskbar pins, account. Reuses the same stored values as the controls it mirrors. |

## Multi-device (Devices sidebar)

| Control | Status | Notes |
| --- | --- | --- |
| Selected / Multi / All, broadcast input | Existing | |
| Select all / Clear | Added | Ticks every online phone (Multi) / clears |
| Group control | Added | Chips for saved groups (Automate → Groups) set the Multi selection |
| Reconnect | Added | Restarts the video session on targets; ticked offline phones get `adb reconnect`. Input is never sent to offline phones. |

## Floating panel placement

The Tools panel is taller with the new buttons. On short phones the panels
now share the free space around the grid bar and Arrangement strip: a panel
that cannot fit is shortened and its tools scroll, instead of covering the
bar or the other panel.

# Phone controls

App controls, phone tweaks, Shizuku and logcat. Each one is an `adb shell` command that ADBoard runs from the computer, so the phone needs only USB or wireless debugging. Nothing is installed on the phone.

The command recipes follow [Shizuku-Next](https://github.com/rushiranpise/Shizuku-Next) (Apache-2.0). Shizuku-Next is a phone app whose adb-started server has the same "shell" rights ADBoard has over adb. No code is copied: ADBoard runs the same commands from the computer instead.

Every value that reaches the phone's shell is checked against an allow-list or quoted. This covers package and permission names, app-op names and modes, buckets, intent flags and extras, and tweak names. Agent code: `crates/adboard-agent/src/app_controls.rs` (commands and parsers) and `crates/adboard-agent/src/logcat.rs` (logcat and the crash watcher).

## Apps → Controls

Type or pick a package and press **Read app**. ADBoard reads the app from the first checked phone; every change goes to all checked phones, and a result shows for each one.

| Part | What it does | Command |
|---|---|---|
| State | Suspend / unsuspend, disable / enable, uninstall for user 0 (keeps data), restore a removed system app | `pm suspend`, `pm disable-user`, `pm uninstall -k --user 0`, `cmd package install-existing` |
| Standby bucket | Active … Restricted | `am set-standby-bucket` |
| Not battery optimised | Exempt from Doze and App Standby | `dumpsys deviceidle whitelist +pkg` (or `cmd deviceidle`) |
| Network access | Off blocks Wi-Fi and mobile data for the app | `cmd connectivity set-chain3-enabled true` + `set-package-networking-enabled` |
| Permissions | Grant or revoke runtime permissions | `pm grant` / `pm revoke --user 0` |
| App ops | Set any op to allow / ignore / deny / default / foreground. `RUN_ANY_IN_BACKGROUND = ignore` is how Android stops an app in the background | `cmd appops set` (read back with `cmd appops get`) |
| Screens | Every activity in the app's manifest; **Open** exported ones, **Open hidden** for the rest | APK copied to the computer and its manifest read; `am start -n` |
| Send intent | A broadcast or activity start | `am broadcast` / `am start` |

Notes:

- **Network access:** only on phones that have the `cmd connectivity` package firewall (Android 13 and newer on most ROMs). Elsewhere the switch is greyed out and says so.
- **Open hidden:** briefly sets the screen as the phone's assistant (`secure assistant`), presses the assist key, then puts both assistant settings back.
- **Send intent:** allows only `-a -c -d -t -n -p -f`, `--receiver-foreground`, `--include-stopped-packages` and the extras `--es --ez --ei --el --ef --ed`. Values with spaces go in quotes. Each value is checked against its type and quoted.
- **Standby buckets:** "Exempted" and "Never" are set by the phone and can't be chosen.

## Manage → Tweaks

Phone-wide settings, as one switch per checked phone. Each switch shows what the phone reports after the change.

| Switch | On | Off |
|---|---|---|
| Hide Developer options | `development_settings_enabled 0`, then `adb_enabled 1` (and wireless debugging back on if it was on) | `development_settings_enabled 1` |
| Phantom process killer off | `settings_enable_monitor_phantom_procs 0` (Android 12+) | the setting is deleted (Android's default) |
| Force dark | `setprop debug.hwui.force_dark true` plus the vendor keys `force_dark_mode_on`, `hwui_force_dark`, `aosp_force_dark_mode`, `op_force_dark_entire_world` | all back to off |

Things to know:

- **Hide Developer options:** never writes `adb_enabled 0`, because that would disconnect the phone from ADBoard. Apps that only check the Developer options switch see it off while adb keeps running. A few ROMs still drop adb when the switch changes. Try it on one phone first.
- **Force dark:** the property is cleared on reboot. Apps open before the change need a restart, and Android 16 mostly ignores it.

The same switches are a Shell Automation step: **Phone tweak**.

## Shizuku

**Manage → Tweaks** shows whether Shizuku's server runs on each phone (`pidof shizuku_server`). **Start** starts it with the same command Shizuku's "Start via computer" screen gives: `…/lib/<abi>/libshizuku.so`, from the app's folder. Older releases use `start.sh` instead.

This works for Shizuku, thedjchi's fork and Shizuku-Next, which all install as `moe.shizuku.privileged.api`. Open the app once on the phone first. **Start Shizuku on all** and the Shell Automation step **Start Shizuku** are handy after reboots, because the server does not survive one.

## Developer → Logcat

Live `logcat` from one phone:

- **Filters:** narrow it to one app (by its uid, so every process and restart is included; older phones fall back to its pid) and a minimum level.
- **Viewing:** search, pause, clear and **Save .txt**. The view keeps the last 3,000 lines.
- **Rate limit:** the agent sends at most 2,000 lines a second and counts the rest as skipped.

WebSocket: `/ws/devices/{serial}/logcat`. The first client message is `{"package": "…", "level": "W"}`. The agent answers with `{"lines": […]}`, `{"note": "…"}` and `{"skipped": n}`. Phones on another ADBoard computer are relayed like the video.

## App crashes in Events

ADBoard follows each online phone's crash buffer (`logcat -b crash`). A Java or native crash is recorded as **app.crashed** (category Apps, level Error), with the first lines of the report. Discord follows the Apps level in **Settings → Discord notifications**. See [monitoring.md](monitoring.md).

## "Open app" step

In a touch macro's **Open app** step, **List screens on <phone>** reads the app's screens from the previewed (or first ticked) phone and fills the activity from a list.

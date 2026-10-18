# ADBoard user guide

ADBoard is a web page for controlling Android phones that are plugged into a PC (or joined over Wi-Fi). You see each phone's screen live, tap and type on it from your computer, and run the same steps on many phones at once.

This guide is for using it. For installing and running it, see the [README](../README.md); for where your files are kept, see [storage.md](storage.md).

## First five minutes

1. **Start ADBoard** on the PC the phones are plugged into (on Windows: `run.bat`), then open `http://127.0.0.1:3848/` in a browser. From another computer or a phone, use the PC's address instead, for example `http://192.168.1.20:3848/`.
2. **Prepare the phone:** turn on *Developer options* and *USB debugging*, plug it in, and accept the "Allow USB debugging?" prompt on the phone.
3. **Find it in ADBoard:** the phone appears under **Devices** (right) and **Screens** (left) on the **Control** tab. A green dot means online.
4. **Control it:** click the phone's picture to tap, drag to swipe, and type on your keyboard (turn **Keyboard** on). **Back / Home / Recent** sit under the screen.
5. **Add more phones:** plug them in. They appear on their own. Wi-Fi phones are added under **Manage → Wireless**.

Anything you build (macros, scripts) and your settings are saved automatically in one folder on the PC. Updating ADBoard never touches it.

## Which tool do I use?

| I want to… | Use |
|---|---|
| Play a recorded or hand-built series of **finger taps and swipes** over and over, on one or many phones | **Macros** |
| Run a **list of actions** (open an app, wait, take a screenshot, send a file, press a key, run a command) on many phones | **Shell Automation** |
| Do something once, by hand | **Control**, **Manage**, **Apps**, **Files** |

Short version: **Macros are about where a finger goes and when. Shell Automation is about what the phone should do.** They are separate on purpose, and each is saved on its own.

## Control

The live phone, with the tools under it: **Keyboard** and **Touch** switches, Record and Replay (record your own taps), Refresh, install an APK, screenshot, screen recording, Fill (use the whole window), Grid view and **Macro**.

- Your saved apps appear as buttons under the phone. One tap opens the app on the phone you're controlling.
- **Grid view** shows every phone as a tile. Choose who your taps go to: **Selected** (one phone), **Multi** (the ticked phones) or **All**.
- On a phone-sized screen the same tools live in the floating **Tools** panel and a bottom taskbar. In Tools, tap **Taskbar** and then an icon to pin the ones you use most.
- **Stats** shows or hides the line under the phone with its size, battery, temperature, CPU, memory and frame rate. On a phone screen it scrolls across.

## Manage

Actions for the phones you tick: reconnect, restart ADB, reboot, shut down, take screenshots, record the screen, read device information, and add phones over **Wireless**. Reboot and shut down always ask first. The result list says how each phone did.

## Apps

- **Launcher:** the apps you've saved as buttons. **Launch** opens one; **Launch group** opens a whole group.
- **Install APK:** install an app file on the ticked phones.
- **Packages:** look up an app's package id on a phone, then Launch, Force Stop, Uninstall or Clear Data.

To save an app as a button, add it with its **package id** (for example `com.example.game`). You don't need to give it an icon: ADBoard reads the app's own icon from the phone. A coloured letter shows if that isn't possible, and an icon you type always wins.

## Files

Two panes: the **PC** and the **PHONE**. Drag files between them, or use Upload. The PC side's shortcuts (Downloads, APKs, Recordings, Screenshots) are folders in ADBoard's data folder.

## Macros

A **macro** replays finger touches: taps, long presses, swipes and multi-finger gestures, with exact timing. Typical uses are repeating a button in a game, collecting rewards, or farming.

**Example: tap "Collect" every few seconds, forever**

1. Open **Macros**. Press **+** for a new macro and type its name, for example `Daily Login`.
2. **Add → Tap**. Click the **Preview** (it shows a phone's live screen) where the button is, or type its X and Y. Set **Then wait** to 3000 ms.
3. Add more taps for further buttons, in order.
4. In the **Run** card, tick the phones under **Phones for this tab** (or press **All online**).
5. Beside **Run**, choose **Repeat → Loop forever** and press **Run**. Press **Stop** when you're done. You can **Pause** and resume as well.

Things worth knowing:

- Each macro is its own tab. Several can run at once on different phones; a phone runs one at a time.
- Positions are stored for a reference screen size and scaled to each phone, so one macro works on phones with different resolutions.
- The separate **Phones** card lets each phone have its own macro with its own Start / Pause / Stop.
- **Queue** plays macros one after another. **Schedule** starts one at a time, once, or every N minutes.
- Macros keep running when you close the browser, but not when ADBoard is closed.
- **Import** reads ADBoard macro files and Auto Clicker configs. **Export** saves one macro, all macros, or an Auto Clicker file.

Full reference: [macros.md](macros.md).

## Shell Automation

A **script** is a list of actions that ADBoard performs on the phones you choose: start or stop an app, install an APK, run a command, take a screenshot, press a key, send or fetch a file, tap or swipe, wait.

**Example: open a game, wait, and take a screenshot on every phone**

1. Open **Shell Automation → Library → New job**. Name it `Launch Game`.
2. In the **Builder**, **Add → Launch app** and enter the package id.
3. **Add → Wait** for 10 seconds, so the game can load.
4. **Add → Screenshot**.
5. Tick the phones, choose **At the same time**, and press **Run**. Each phone shows its progress, and the **Log** shows what happened on each one. The screenshots land in the Files area under Screenshots.

Things worth knowing:

- The **Builder** shows the phone's live screen beside the steps, so you can place touch steps by clicking on it. ▶ on a step tests just that step.
- **Variables** (`${NAME}`) let one script work with different values; **Groups** are named sets of phones; **Profiles** hold per-phone settings; **History** lists the last runs.
- A script runs while its page is open in the browser. A macro that must keep going without one belongs in Macros.
- Steps that use ADB (shell, files, install, uninstall) need a real phone, not the demo phones.

Full reference: [shell-automation.md](shell-automation.md).

## Developer, Hosts and Settings

- **Developer:** type an `adb shell` command and run it on the ticked phones, read the logs, and see device information.
- **Hosts:** the computers that run ADB and the phones on each. A second PC or a Linux machine can join as an extra host.
- **Settings:** stream quality and size, keyboard and cursor options, stats and grid options, the sign-in account, and **Data & storage** (see below).

## Your files and backups

Everything you make is saved on the ADBoard PC in `%LOCALAPPDATA%\ADBoard`:

- a macro is one `.adboard-macro.json` file in `macros`
- a script is one `.adboard-shell.json` file in `shell_scripts`
- settings are in `config`, and old versions and deleted items are in `backups`

**Settings → Data & storage** shows these places, opens them, makes a backup (**Back up now**), and exports or imports your whole library as one file, `adboard-library.json`. To move to another PC, export the library and import it there. Nothing is deleted without being kept in `backups` first.

## If something doesn't work

- **No phone appears:** check USB debugging and the cable, accept the prompt on the phone, then use **Manage → Actions → Restart ADB**.
- **The screen is black or stuck:** use **Refresh** under the phone.
- **A macro does nothing:** make sure phones are ticked under **Phones for this tab** and online, and that the macro has at least one enabled step.
- **A script step fails:** read the **Log**; the reason from the phone is shown as it was reported.
- **An app has no icon:** the phone must be connected the first time. A letter badge is shown until then.

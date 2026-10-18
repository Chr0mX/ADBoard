# Getting started

Back to the [guide index](README.md).

This page takes you from nothing to controlling a phone, then shows what is on the screen.

## What you need

- A Windows PC that the phones will be plugged into (the "ADBoard PC"). ADBoard can also run on Linux.
- A USB cable per phone, or phones on the same Wi-Fi.
- A browser: Chrome, Edge or Safari. The live picture needs H.264 video support, which these have.
- **ADB** and **scrcpy**, the two small tools ADBoard uses to talk to phones and show their screens. They go in the pack's `vendor` folder.

## Install and start (Windows)

1. Copy the `dist\windows` folder to the PC.
2. Put ADB and scrcpy in `vendor\adb` and `vendor\scrcpy`. From the project folder, `.\scripts\fetch-deps.ps1` downloads and places them for you. The READMEs in those folders explain a manual download.
3. Double-click **`run.bat`**. A window opens and stays open while ADBoard runs.
4. Open **http://127.0.0.1:3848/** in a browser on that PC. From another computer or a phone on your network, open `http://<the PC's address>:3848/` instead; allow TCP port 3848 in Windows Firewall if the PC blocks it.

Your macros, scripts and settings are kept in `%LOCALAPPDATA%\ADBoard`, outside the ADBoard folder, so updating or replacing the folder never touches them. See [Your files and backups](../storage.md).

## Prepare each phone

1. Open **Settings → About phone** and tap **Build number** seven times to turn on Developer options.
2. In **Developer options**, turn on **USB debugging**.
3. Plug the phone in. On the phone, tap **Allow** on the "Allow USB debugging?" prompt (tick "Always allow from this computer" to see it only once).

## Your first phone

1. Open the **Control** tab. Within a few seconds the phone appears under **Devices** (right) and **Screens** (left), with a green dot when it is online.
2. Click it. Its screen appears in the middle.
3. Click on the screen to tap; drag to swipe. Turn **Keyboard** on (the first button under the phone) and type on your computer's keyboard to type on the phone.
4. Use **Back**, **Home** and **Recent** under the screen for Android's navigation.

To add more phones, plug them in. Phones on Wi-Fi are added in **Manage → Wireless** (see [manage.md](manage.md)).

If the phone doesn't appear, see [Troubleshooting](troubleshooting.md).

## A tour of the screen

- **Top bar:** the tabs, how many phones are online, and **Set password** (or your account name).
- **Screens (left):** a small picture of each phone. Click one to control it. The arrow folds the column away.
- **Middle:** the phone you are controlling, with its volume and power buttons, and under it Back / Home / Recent, your app buttons, and the tool row.
- **Devices (right):** every phone, with its name, model, screen size, battery and temperature. Tick phones to send actions to several at once, and use **Selected / Multi / All** to choose who your taps go to. The arrow folds this column too.

The full details are in [control.md](control.md).

## On a phone or tablet

Open the same address in the phone's browser (or install ADBoard on the Home Screen). Below about 1024 pixels wide, the layout switches to a phone layout: the tools move into a floating **Tools** panel and a bottom taskbar. See [control.md](control.md).

## Where to go next

- Repeat taps on many phones: [Macros](macros.md).
- Run a list of actions on many phones: [Shell Automation](shell-automation.md).
- Save a game or app as a one-tap button: [Apps](apps.md).

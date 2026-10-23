<p align="center"><img src="../../site/assets/logo.svg" alt="" width="64" height="64"></p>

# ADBoard user guide

ADBoard is a web page for controlling Android phones that are plugged into a PC, or joined over Wi-Fi. You see each phone's screen live, tap and type on it from your computer, and run the same steps on many phones at once.

This guide explains every tab. The screenshots use ADBoard's demo phones, which show no picture; with real phones you see their screens.

## Start here

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Install, start ADBoard, connect your first phone, and a tour of the screen |

## The Dashboard

The Dashboard runs across the top of ADBoard, in this order.

| Dashboard | What it is for | Page |
|---|---|---|
| <img src="../../site/assets/icon-live-control.svg" width="20" height="20" alt="" align="absmiddle"> **Control** | The live phone: tap, swipe, type, grid of all phones, app buttons | [control.md](control.md) |
| <img src="../../site/assets/icon-device-fleet.svg" width="20" height="20" alt="" align="absmiddle"> **Manage** | Reconnect, reboot, screenshots, recording, device info, Wi-Fi pairing | [manage.md](manage.md) |
| <img src="../../site/assets/icon-apps.svg" width="20" height="20" alt="" align="absmiddle"> **Apps** | Saved app buttons, installing APKs, package tools | [apps.md](apps.md) |
| <img src="../../site/assets/icon-files.svg" width="20" height="20" alt="" align="absmiddle"> **Files** | Move files between the PC and a phone | [files.md](files.md) |
| <img src="../../site/assets/icon-automation.svg" width="20" height="20" alt="" align="absmiddle"> **Macros** | Replay finger taps and swipes, with timing, on many phones | [macros.md](macros.md) |
| <img src="../../site/assets/icon-automation.svg" width="20" height="20" alt="" align="absmiddle"> **Shell Automation** | Run a list of actions (open app, wait, screenshot, send file, key, command) on many phones | [shell-automation.md](shell-automation.md) |
| <img src="../../site/assets/icon-adb-terminal.svg" width="20" height="20" alt="" align="absmiddle"> **Developer** | Run an ADB shell command, read logs, device information | [developer.md](developer.md) |
| <img src="../../site/assets/icon-device-fleet.svg" width="20" height="20" alt="" align="absmiddle"> **Hosts** | The computers that run ADB, and the phones on each | [hosts.md](hosts.md) |
| **Storage** | Where your data is kept, its size, and how to move it | [settings.md](settings.md#data--storage) |
| <img src="../../site/assets/icon-settings.svg" width="20" height="20" alt="" align="absmiddle"> **Settings** | Stream quality, keyboard, grid, account, data and backups | [settings.md](settings.md) |

## Which one do I use?

| I want to… | Use |
|---|---|
| Do something once, by hand | **Control**, **Manage**, **Apps**, **Files** |
| Repeat **finger taps and swipes**, with exact timing, on one or many phones | **Macros** |
| Run a **list of actions** on many phones: open an app, wait, take a screenshot, send a file, press a key, run a command | **Shell Automation** |

Short version: **Macros are about where a finger goes and when. Shell Automation is about what the phone should do.** They are separate on purpose and each is saved on its own.

## Reference

| Page | What it covers |
|---|---|
| [Your files and backups](../storage.md) | Where ADBoard keeps your macros, scripts and settings; export, import, backup, migration |
| [Troubleshooting](troubleshooting.md) | When a phone doesn't show up, the screen is black, or a run does nothing |
| [Macros reference](../macros.md) | How macros are timed and played back, and their file format |
| [Shell Automation reference](../shell-automation.md) | Each action, its fields, and how a job runs |
| [Remote access](../../README.md#remote-access-nginx-proxy-manager--cloudflare) | Using ADBoard from outside your network |

# Troubleshooting

Back to the [guide index](README.md).

## No phone appears

1. Check that **USB debugging** is on (see [Getting started](getting-started.md)) and the cable carries data, not only power. Try another cable or port.
2. Look at the phone: accept the **Allow USB debugging?** prompt. A phone that hasn't accepted it shows **unauthorized**; the Control screen says to accept the prompt and tap **Reconnect**.
3. Open **Manage → Actions** with the phone ticked and press **Reconnect**, then **Restart ADB** if it still doesn't show.
4. Make sure no other program (another ADB, an emulator tool) is holding the phone.
5. On the PC, check that `vendor\adb\adb.exe` exists. Without ADB, ADBoard can't see real phones.

## A phone shows "offline"

The PC can't reach it: reconnect the cable or Wi-Fi, then **Reconnect**. For a Wi-Fi phone, pair it again in **Manage → Wireless**. Offline phones are skipped when you run macros or scripts.

## The screen is black, frozen or says "recovering"

Press **Refresh** under the phone, or **Reconnect** in the Devices column. The stream restarts. If the picture never appears, check that your browser supports H.264 video (Chrome, Edge, Safari). Some headless or locked-down browsers can't show it.

## Taps or typing don't reach the phone

- Make sure **Touch** (and, for typing, **Keyboard**) is switched on under the phone.
- Check who is being controlled: **Selected** sends to one phone, **Multi** to the ticked phones, **All** to every online phone.

## A macro does nothing

- Tick at least one online phone under **Phones for this tab** in the Run card.
- Check the macro has an enabled step, and that its X and Y are inside the reference screen.
- A phone runs one macro at a time; a busy phone is skipped, and the status says which macro it is running.
- Macros stop when ADBoard itself is closed.

## A script step fails

Open the **Log** in the Builder. The reason from the phone or ADBoard is shown as reported, for example "adb is not available" or "package name is not valid". Steps that use ADB (shell commands, files, install, uninstall) need a real phone; the demo phones can't run them. Steps that need fixing are outlined in red, and **Run** is blocked until they are fixed.

## An app button has no icon

The first time, the phone must be connected so ADBoard can read the app's icon, which it then keeps. A coloured letter shows until then, and it stays if the icon can't be read. You can type an icon in the app's edit form to use your own.

## Something I made is gone, or two copies exist

Nothing is deleted without being kept: look in `%LOCALAPPDATA%\ADBoard\backups`. **Macros → Versions** restores an earlier copy of your macros. See [Your files and backups](../storage.md).

## I forgot my password

Start ADBoard once with `ADBOARD_PASSWORD` set to a new password and `ADBOARD_RESET_PASSWORD=1`. See [Remote access](../../README.md#remote-access-nginx-proxy-manager--cloudflare).

## Still stuck

The log file `%LOCALAPPDATA%\ADBoard\logs\adboard.log` records what ADBoard did, and **Developer → Logs** shows a phone's own log.

Back to the [guide index](README.md)

# Apps

The Apps tab lets you start, install and manage apps on your phones. **Launcher** keeps your own list of app shortcuts that you can start on one phone or many. **Install APK** puts an app file onto several phones at once. **Packages** lets you start, stop, remove or wipe an app by its package id.

Two terms: an **APK** is an Android app file (its name ends in .apk). A **package id** (also called package name) is an app's unique name, such as `com.android.chrome`.

## Contents

- [Launcher](#launcher)
- [Install APK](#install-apk)
- [Packages](#packages)
- [How to](#how-to)
- [Good to know](#good-to-know)

The page title is **Apps**, with three buttons: **Launcher**, **Install APK** and **Packages**. The phones you ticked on the Control tab are ticked here to begin with. Every sub-tab has a **Target devices** list with tick boxes, and a result list that shows one line per phone.

## Launcher

![The Launcher on real phones: apps sorted into Games and Tools, each showing its own icon](images/apps-launcher.jpg)

*Launcher: shortcuts sorted by category. Grand Summoners, Speedtest and Auto Clicker show their own icons, read from the phone. Each card has Launch, All, Edit and Delete.*

Your shortcuts are shown by **category**: **Games**, **Media**, **Tools** and **Custom** are always there, followed by any category you make yourself. An app appears only under its own category. A shortcut card shows the app's icon, its name and its package id. Shortcuts are saved with your ADBoard library (see [where ADBoard keeps your data](../storage.md)).

| Button | What it does |
|---|---|
| Launch | Starts the app on the phones ticked in Target devices. |
| All | Starts the app on every phone that is online, ignoring the ticks. |
| Edit | Opens the shortcut so you can change it. |
| Delete | Removes the shortcut from your list straight away, without asking. It does not touch the app on any phone. |
| Add app (top right of each category) | Opens the Add app dialog with that category already chosen. |
| Add app (top right of the page) | Opens the Add app dialog; the category starts on Custom. |
| Launch group (top right of each category, when it has shortcuts) | Starts every app in that group, one after another, on the ticked phones. Result lines are prefixed with the app's name. |
| Add App (dashed box, in the Custom group) | Opens the form to create a new shortcut. |

### Shortcut icons

- If you type an icon (an emoji or a short symbol) it is always used.
- If the Icon field is empty, ADBoard reads the app's own icon from the phone once and remembers it. A phone must be connected the first time. This uses the phone you are looking at if it is online, otherwise the first online phone.
- If the icon cannot be read, you see a coloured badge with the first letter of the app's name. The colour is always the same for the same app. ADBoard tries again about a minute later.

### The Add app dialog

![The Add app dialog after a scan, with the list of apps, the category and the Details section](images/apps-add.jpg)

*Add app: scan a phone, tick the apps you want, choose a category, and add them.*

One dialog covers finding an app, naming it and filing it under a category. **Edit** on a card opens the same dialog with that app's values.

1. **Phone to scan:** the phone to read the app list from. Only online phones can be chosen; an offline phone is shown greyed out with its state.
2. **Scan installed apps:** reads the phone's apps. The button shows "Scanning…" while it works and then "Found 37 apps you installed on S24." If the phone can't be reached you see the reason ("S24 is offline", or the message from ADB). By default only apps you installed are listed. Tick **Include system apps** to see the phone's built-in apps too. After a scan the button reads **Scan again**.
3. **The list:** every app has a checkbox, its icon, its name and its package id. Names and icons are read from the phone as you scroll, so they appear a moment after the list does; until then (or if the phone doesn't give them) you see the package id and a coloured letter. **Search apps** filters by name or package id, for example `grand`. An app you have already saved shows "Already added (category)" and can't be ticked, so scanning again never makes a duplicate.
4. **Category:** the dropdown lists Games, Media, Tools, Custom and any category you made before. Choose **New category…** and type a name to make one. A name that matches an existing category in any letter case reuses it.
5. **Details:** the manual fields. Open this part to enter an app by hand, or to change what a scan filled in.

| Field | What it does |
|---|---|
| Package | The package id, for example `com.example.grandsummoners`. Required, and it must not already be saved. |
| Name | The label on the card. If empty, the app's name from the phone is used, or else the last part of the package id. |
| Icon (optional: empty uses the app's own icon) | See "Shortcut icons" above. |
| Activity (optional) | A specific screen inside the app to open, for example `com.example.grandsummoners.MainActivity`. Empty means open the app normally. Ticking one app in the scan fills this in for you when the phone knows it. |
| Arguments (optional) | Extra settings passed with the activity, such as `--es user bob`. Only used if Activity is filled in. |

**One app or several:** tick one app and its Package, Name and Activity are filled in, ready to adjust. Tick several and the dialog says how many are selected, and the button becomes **Add N apps**: they are all saved in the chosen category, named as shown in the list, with no icon of their own (so each uses its app's own icon). To change a name or icon, add the app on its own, or use **Edit** afterwards.

**Refused:** a package that is already saved is refused with "Already saved as “Telegram” in Tools." (it names the existing shortcut and where it is), and a package id that isn't valid asks you to correct it.

## Install APK

![The Install APK sub-tab with the drop box and INSTALL button](images/apps-install.jpg)

*Install APK: choose a file, tick phones, press INSTALL.*

| Control | What it does |
|---|---|
| Drop box ("Drag an APK into the UI") | Drag an APK file onto it, or click it to choose a file. After you choose, it shows the file name. Only files ending in .apk are accepted. |
| Target devices | Tick the phones to install on. |
| INSTALL | Installs the APK on every ticked phone. It is greyed out until a file is chosen and at least one phone is ticked. |

The result list shows "Installed" with a tick for each success, or the reason for a failure. If the app is already on the phone it is updated in place and keeps its data. Phones you did not tick show "Skipped".

Big files: files over 64 MB are sent to ADBoard in 32 MB pieces automatically, so you do not need to do anything. The largest file ADBoard accepts is 256 MB. Large installs can take a while; leave the page open until a result appears.

## Packages

![The Packages sub-tab with the package field and four buttons](images/apps-packages.jpg)

*Packages: act on one app by its package id.*

| Control | What it does |
|---|---|
| Package | The package id to act on. It starts as `com.example.app`, which is only a placeholder; replace it. |
| Scan <phone name> | Lists the apps on the phone you are looking at and puts the first one in the Package box. It does not show the whole list. |
| Launch | Starts the app on the ticked phones. |
| Force Stop | Stops the app if it is running. |
| Uninstall | Removes the app for the main user of each ticked phone. It does not ask first. |
| Clear Data | Wipes the app's saved data (settings, logins, game progress). It asks first. |

Clear Data shows a box titled "Clear application data?" with the package id and the text "This will remove the application's local data." Press **Clear Data** to go ahead, or **Cancel** to back out. Uninstall has no such box, so check the package id before you press it.

The package id may only contain letters, numbers, dots and underscores, and must have at least one dot. Anything else is refused with "package name is not valid".

## How to

### Add an app shortcut

1. Open Apps, then **Launcher**.
2. Press **Add app** at the top right of the category you want (or the one at the top of the page).
3. Choose the phone in **Phone to scan** and press **Scan installed apps**.
4. Type part of the name in **Search apps** if the list is long, then tick the app.
5. Check **Category**; choose **New category…** to make one.
6. Press **Add app**. The card appears under its category.

### Add several apps at once

1. In the Add app dialog, scan the phone and tick every app you want.
2. Choose one category for all of them.
3. Press **Add N apps**.

### Make your own category

1. In the Add app dialog, open **Category** and choose **New category…**.
2. Type a name, such as `Farm bots`, and add your app. The category appears below Custom as its own section, and **Edit** on any app can move it to a different category later.
3. A category you made disappears when no app uses it any more.

### Start an app on several phones

1. In **Launcher**, tick the phones in Target devices (at the bottom of the page).
2. Press **Launch** on the app's card. To start it on every online phone instead, press **All**.

### Install an APK on several phones

1. Open **Install APK** and drop the file onto the box.
2. Tick the phones.
3. Press **INSTALL** and read the result list.

### Wipe an app's data

1. Open **Packages** and type the package id (or press Scan to fill one in).
2. Tick the phone.
3. Press **Clear Data**, check the id, and press **Clear Data** in the box.

## Good to know

- Nothing happens on phones you have not ticked, except **All**, which uses every online phone.
- Offline phones are never sent commands. A ticked offline phone shows "No result" in the result list; if every ticked phone is offline, an install reports "no online targets for install".
- The activity and arguments are checked for safety. Characters such as ; | & $ quotes and backslashes are refused in arguments.
- Delete on a shortcut and Uninstall in Packages act immediately. Clear Data is the only action here that asks first.

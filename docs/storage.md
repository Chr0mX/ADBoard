# Where ADBoard keeps your data

ADBoard keeps everything you make or change in one **data folder**. On the Windows pack that folder is `ADBoard` in the repository root, for example `D:\GitHub\Phone-farm\ADBoard`. Other installs use `adboard-data` next to `ADBoard.exe`. Git pulls, updates and reinstalls don't touch it.

The **Storage** tab shows where the folder is, how big each part is, and lets you choose another location.

| Where the folder comes from | When |
|---|---|
| `ADBOARD_DATA_DIR` | Set in the environment. This always wins. |
| The location saved in the **Storage** tab | `adboard-location.json` in the app folder. Takes effect on the next start. |
| `ADBOARD_APP_DATA_DIR`, or `adboard-data` beside the executable | The app folder. The Windows pack sets `ADBOARD_APP_DATA_DIR` to `ADBoard` in the repository root. |
| Your user folder (`%LOCALAPPDATA%\ADBoard` on Windows, `~/Library/Application Support/ADBoard` on macOS, `~/.local/share/ADBoard` on Linux) | When it already holds data and the app folder doesn't. It is kept there until you move it. |

## Changing the location

In the **Storage** tab:

- **Switch to app folder** / **Switch to user folder** changes the location between the app folder and your user folder. If the other folder already has data, ADBoard only saves the location and copies nothing. If it is empty, the data is copied there and checked first. Both copies are kept, so you can switch back at any time.
- **Use this folder** saves a folder that already has data, or an empty one. Nothing is copied.
- **Move data here** copies everything into a new folder, then checks the copy before saving the location. A folder that already has files is refused. A folder that holds only `temp` counts as empty. Temporary files (`temp`) are never copied. The old folder is never deleted.

Restart ADBoard to use the new folder. Stop changing things while a move runs.

## Folders

```
ADBoard\
├── macros\          <Name>.json   one file per touch macro
│                    _workspace.json              tab order and the open tab
├── shell_scripts\   <Name>.json   one file per Shell Automation script
│                    _library.json                apps, variables, groups, tags, phone profiles
├── config\          user_config.json             settings shared by every browser
│                    browser_state.json           layout and navigation, per browser
│                    builder_state.json           Shell Automation / Macros editor state, per browser
│                    macro_queue.json, macro_schedules.json, macro_assignments.json
│                    wireless_devices.json        saved Wi-Fi ADB phones
│                    auth.json                    sign-in account (salted PBKDF2 hash only)
│                    migration.json               what was moved in from older versions
│                    .revisions.json              internal (revision numbers)
├── logs\            adboard.log (rotated at 5 MB, 3 kept), shell_run_history.json
├── backups\         history\     the last 20 saved versions of each store (Macros → Versions)
│                    deleted\     files of deleted or renamed macros and scripts
│                    corrupt\     copies of files that could not be read
│                    backup-<date>\   made by Back up now and before a library import
│                    legacy-<date>\   originals moved in from older versions
├── cache\           app-icons\<package>.png and .json: the icon and name read from your phone the first time an app is shown in a scan or without an icon (the phone must be connected; safe to delete)
├── files\           Files area: Screenshots, Recordings, APKs, Downloads
└── temp\            staged uploads and installs (runtime only)
```

## What is saved, and how

- **Automation files** (`macros`, `shell_scripts`) are saved as soon as you
  edit. Each file is named after the item: invalid Windows characters
  (`<>:"/\|?*`) and spaces become `_`, reserved names such as `CON` get a `_`,
  names are capped at 80 characters, and an empty name becomes
  `Untitled_macro` / `Untitled_script`. If two names would give the same file
  (Windows names ignore case) the second gets `_2`. Display names stay as you
  typed them, and two items in the same list can't share a name: a duplicate
  gets " 2".
- **Renaming** writes the new file and moves the old one to `backups\deleted`.
  The queue, schedules, per-phone choices and profiles refer to items by id, not
  by name, so renaming breaks nothing.
- **Preferences** (keyboard, stream quality, taskbar pins, grid…) are saved in
  `config\user_config.json` and shared by every browser. **Layout** (section,
  last phone, folded panels, grid view, Files paths) and **editor state** (open
  script, preview phone, selected step) are saved per browser in
  `browser_state.json` / `builder_state.json`. A browser opened for the first
  time starts from the most recent layout. Browsers keep a working copy in
  their own storage, so ADBoard still works for a moment if the agent restarts.
- **Not saved:** passwords, session cookies and API tokens never go into these
  files. The sign-in account is stored only as a salted hash in `config\auth.json`.
- **Temporary:** `temp`, live runs, and floating panel positions (per tab).

Every write goes to a temporary file first and then replaces the old one, so a
crash can't leave half a file.

## File names

Macro and script files are named `<Name>.json`, for example `Arena.json` or `New_macro.json`. The folder says what a file is, and the `format` field inside each file says it again (`adboard-macros` or `adboard-shell-script`). ADBoard finds its files by that field, not by the name.

Older versions named them `<Name>.adboard-macro.json` and `<Name>.adboard-shell.json`. On the first start after the update, ADBoard renames those files to `<Name>.json` and updates the folder's index (`_workspace.json` or `_library.json`) to match, so the order is kept. If a plain `<Name>.json` already exists, the renamed file becomes `<Name>_2.json`. No file is overwritten. Each rename is recorded in `config\migration.json`.

Any other `.json` file in `macros` or `shell_scripts` is not an ADBoard file. ADBoard leaves it where it is and shows a warning.

## Editing files by hand

Safe to edit or copy in **while ADBoard is closed**:

- `macros\*.json`: a touch macro file (also what Export makes,
  so you can drop an exported macro in here).
- `shell_scripts\*.json`: a Shell Automation script file.
- `config\user_config.json`.

ADBoard notices the change at the next start. A file it can't read is copied to
`backups\corrupt` and reported in Macros or Shell Automation; the rest still
loads, and nothing is deleted.

Don't edit `.revisions.json`, `browser_state.json`, `builder_state.json`,
`migration.json` or `auth.json`.

## Export and import

| What | File | Where |
|---|---|---|
| One touch macro | `<Name>.json` | Macros → Export → This tab |
| All touch macros | `adboard-macros.json` | Macros → Export → All tabs |
| One Shell Automation script | `<Name>.json` | Shell Automation → Library → Export |
| Everything | `adboard-library.json` | Storage tab (export, import and backup), or Shell Automation → Export library |
| Auto Clicker | `<Name>-autoclicker.txt` | Macros → Export (third-party format) |

`adboard-library.json` holds touch macros, Shell Automation scripts, apps,
variables, groups, phone profiles, the macro queue, schedules and per-phone
macro choices.

- **Save dialog:** Chrome and Edge open a Save dialog, which asks before
  replacing a file. Other browsers download, and add " (1)" to a duplicate name.
- **Formats:** imports recognise a file by its contents, not its extension, so
  renaming a file doesn't change what it is.
- **Older files still import:**
  - In Shell Automation: PhoneControl desk exports (`phonecontrol-desk.json`)
    and raw job JSON.
  - In Macros: `.adboard-macros.json` files and Auto Clicker configs.
- **Shell Automation → Import** adds scripts. A script that is already there
  (same id and contents) is skipped, and a name clash gets " 2".
- **Library import** offers **Add**, which keeps the current items, skips ones
  already there and renames clashes, or **Replace**, which asks to confirm.
  Either way the data folder is backed up to `backups\backup-<date>` first.

## Moving in data from older versions

On start, ADBoard looks for data from before it used the data folder. It checks
next to `ADBoard.exe`, in the repo's `dist\windows`, the repo, the folder it was
started from, and `PHONECONTROL_DATA_DIR`. It looks for:

- `adboard-data` (macros, Shell Automation, queue, schedules, phone choices)
- `adboard-auth.json` / `rasiel-auth.json` (sign-in account)
- `data\phonecontrol-files` (Files area)
- `data\wireless-adb.json` (saved Wi-Fi phones)

Each one is copied in and read back to check it matches. Only then is the
original moved to `backups\legacy-<date>`, with a `MOVED_TO_ADBOARD.txt` note
left in its old place. Existing data is never overwritten: if the data folder
already has macros, the older copy is kept in the backup and listed in
the Storage tab, where you can import it. If a check fails, the
original stays where it was and the error is shown. The result is recorded in
`config\migration.json`.

Browser storage from older versions (`phonecontrol-*` keys) moves to the new
`adboard-*` keys the first time a browser opens ADBoard.

## Environment

| Variable | Purpose |
|---|---|
| `ADBOARD_DATA_DIR` | Data folder (portable mode, tests) |
| `ADBOARD_APP_DATA_DIR` | The app folder: the default data location and the target of the Switch button. The Windows pack sets it to the `ADBoard` folder in the repository root. |
| `ADBOARD_FILES` | Files area, if not `files` |
| `ADBOARD_TEMP` | Temp folder, if not `temp` |
| `ADBOARD_AUTH_FILE` | Sign-in account file, if not `config\auth.json` |
| `ADBOARD_WIRELESS` | Saved Wi-Fi phones file, if not `config\wireless_devices.json` |

Older `PHONECONTROL_*` names are still read when the `ADBOARD_*` one is not set.

## Moving the data from a command line

`scripts\move-data.ps1` (Windows PowerShell, with ADBoard closed) copies the data to the app folder, checks every file against its SHA-256 hash, and only then deletes the old folder, if you ask it to:

```powershell
.\scripts\move-data.ps1                 # copy and check, keep the old folder
.\scripts\move-data.ps1 -Delete         # also delete the old folder after the check passes
```

The script refuses to run while ADBoard is open, refuses a target that already has data, and deletes nothing if any file does not match.


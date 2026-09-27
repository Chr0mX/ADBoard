# ADB for Windows (not committed)

Download **Android SDK Platform-Tools** for Windows from Google’s developer site, then copy into this folder:

- `adb.exe`
- `AdbWinApi.dll`
- `AdbWinUsbApi.dll`

`Start-PhoneControl.ps1` sets `ADB_PATH` to `vendor\adb\adb.exe` when present.

Do **not** commit these binaries to git (license / redistribution). Install on each Windows host instead.

# ADB for Windows (not committed)

**Automated (preferred):** from the repo root:

```bash
make fetch-deps FETCH_TARGET=windows
# or on Windows PowerShell:
.\scripts\fetch-deps.ps1
```

Downloads go to `./temp/`; this folder receives `adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll`.

**Manual:** download **Android SDK Platform-Tools** for Windows from Google, then copy those files here.

`Start-ADBoard.ps1` sets `ADB_PATH` to `vendor\adb\adb.exe` when present. The agent also auto-discovers this path.

Do **not** commit these binaries to git (license / redistribution).

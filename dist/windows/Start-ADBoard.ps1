# Start ADBoard controller on this Windows USB host (loopback by default).
# Usage (from the pack folder):
#   .\Start-ADBoard.ps1
#   .\Start-ADBoard.ps1 -Bind 0.0.0.0 -Mock
#   .\Start-ADBoard.ps1 -Port 3848 -HostName "desk-pc"
#   .\Start-ADBoard.ps1 -Bind 0.0.0.0 -Password "long passphrase"   # behind a reverse proxy
#   .\Start-ADBoard.ps1 -DataDir "$PSScriptRoot\ADBoard-data"       # portable mode

[CmdletBinding()]
param(
    [ValidateSet("controller", "agent")]
    [string] $Role = "controller",

    [string] $Bind = "127.0.0.1",

    [int] $Port = 3848,

    [string] $HostName = "windows-host",

    [string] $HostId = "",

    [switch] $Mock,

    # First sign-in password (change it later in the UI); needed behind a reverse proxy.
    [string] $Password = "",

    [ValidateSet("auto", "testpattern", "scrcpy", "off")]
    [string] $VideoSource = "auto",

    # Portable mode: keep macros, scripts and settings here instead of %LOCALAPPDATA%\ADBoard.
    [string] $DataDir = ""
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Exe = Join-Path $Root "ADBoard.exe"

if (-not (Test-Path $Exe)) {
    if (Test-Path (Join-Path $Root "PhoneControl.exe")) {
        Write-Warning "Found the old name PhoneControl.exe: rename it to ADBoard.exe."
    }
    Write-Error "ADBoard binary (ADBoard.exe) not found next to this script: $Exe"
}

$Adb = Join-Path $Root "vendor\adb\adb.exe"
$Scrcpy = Join-Path $Root "vendor\scrcpy\scrcpy.exe"
$ScrcpyServer = Join-Path $Root "vendor\scrcpy\scrcpy-server"

if (-not $HostId) { $HostId = $HostName }

$env:ADBOARD_ROLE = $Role
$env:ADBOARD_BIND = $Bind
$env:ADBOARD_PORT = "$Port"
$env:ADBOARD_HOST = $HostName
$env:ADBOARD_HOST_ID = $HostId
$env:ADBOARD_VIDEO_SOURCE = $VideoSource
# Data folder: the ADBoard folder in the repository root (two levels up from dist\windows).
if (-not $env:ADBOARD_APP_DATA_DIR) { $env:ADBOARD_APP_DATA_DIR = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\ADBoard")) }
if ($DataDir) { $env:ADBOARD_DATA_DIR = $DataDir }
if ($Password) {
    $env:ADBOARD_PASSWORD = $Password
    Write-Host "Browser sign-in enabled"
}

if (Test-Path $Adb) {
    $env:ADB_PATH = $Adb
    Write-Host "ADB_PATH=$Adb"
} else {
    Write-Warning "vendor\adb\adb.exe missing — using PATH adb, or set -Mock / ADBOARD_FORCE_MOCK=1"
}

if (Test-Path $Scrcpy) {
    $env:SCRCPY_PATH = $Scrcpy
    Write-Host "SCRCPY_PATH=$Scrcpy"
}
if (Test-Path $ScrcpyServer) {
    $env:SCRCPY_SERVER_PATH = $ScrcpyServer
}

if ($Mock) {
    $env:ADBOARD_FORCE_MOCK = "1"
    $env:ADBOARD_MOCK_PROFILE = "windows"
    if ($VideoSource -eq "auto") {
        $env:ADBOARD_VIDEO_SOURCE = "testpattern"
    }
    Write-Host "Mock fleet enabled (windows profile)"
}

$Host.UI.RawUI.WindowTitle = "ADBoard"
Write-Host "Starting ADBoard ($Role) on http://${Bind}:${Port}/"
$Data = if ($env:ADBOARD_DATA_DIR) { $env:ADBOARD_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "ADBoard" }
Write-Host "Macros, scripts and settings: $Data"
Write-Host "Point UI: NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:${Port}  (or the LAN IP if Bind=0.0.0.0)"
& $Exe

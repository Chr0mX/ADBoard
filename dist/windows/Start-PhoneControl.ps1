# Start Rasiel controller on this Windows USB host (loopback by default).
# Usage (from the pack folder):
#   .\Start-PhoneControl.ps1
#   .\Start-PhoneControl.ps1 -Bind 0.0.0.0 -Mock
#   .\Start-PhoneControl.ps1 -Port 3848 -HostName "desk-pc"

[CmdletBinding()]
param(
    [ValidateSet("controller", "agent")]
    [string] $Role = "controller",

    [string] $Bind = "127.0.0.1",

    [int] $Port = 3848,

    [string] $HostName = "windows-host",

    [string] $HostId = "",

    [switch] $Mock,

    [ValidateSet("auto", "testpattern", "scrcpy", "off")]
    [string] $VideoSource = "auto"
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Exe = Join-Path $Root "PhoneControl.exe"

if (-not (Test-Path $Exe)) {
    Write-Error "Rasiel binary (PhoneControl.exe) not found next to this script: $Exe"
}

$Adb = Join-Path $Root "vendor\adb\adb.exe"
$Scrcpy = Join-Path $Root "vendor\scrcpy\scrcpy.exe"
$ScrcpyServer = Join-Path $Root "vendor\scrcpy\scrcpy-server"

if (-not $HostId) { $HostId = $HostName }

$env:PHONECONTROL_ROLE = $Role
$env:PHONECONTROL_BIND = $Bind
$env:PHONECONTROL_PORT = "$Port"
$env:PHONECONTROL_HOST = $HostName
$env:PHONECONTROL_HOST_ID = $HostId
$env:PHONECONTROL_VIDEO_SOURCE = $VideoSource

if (Test-Path $Adb) {
    $env:ADB_PATH = $Adb
    Write-Host "ADB_PATH=$Adb"
} else {
    Write-Warning "vendor\adb\adb.exe missing — using PATH adb, or set -Mock / PHONECONTROL_FORCE_MOCK=1"
}

if (Test-Path $Scrcpy) {
    $env:SCRCPY_PATH = $Scrcpy
    Write-Host "SCRCPY_PATH=$Scrcpy"
}
if (Test-Path $ScrcpyServer) {
    $env:SCRCPY_SERVER_PATH = $ScrcpyServer
}

if ($Mock) {
    $env:PHONECONTROL_FORCE_MOCK = "1"
    $env:PHONECONTROL_MOCK_PROFILE = "windows"
    if ($VideoSource -eq "auto") {
        $env:PHONECONTROL_VIDEO_SOURCE = "testpattern"
    }
    Write-Host "Mock fleet enabled (windows profile)"
}

$Host.UI.RawUI.WindowTitle = "Rasiel"
Write-Host "Starting Rasiel ($Role) on http://${Bind}:${Port}/"
Write-Host "Point UI: NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:${Port}  (or the LAN IP if Bind=0.0.0.0)"
& $Exe

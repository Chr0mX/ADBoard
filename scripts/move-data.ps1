# Copy ADBoard's data into the app folder, check every file, and only then
# (optionally) delete the old copy.
#
# Usage (PowerShell, from the repo root or dist\windows):
#   .\scripts\move-data.ps1                 # copy and check; keeps the old folder
#   .\scripts\move-data.ps1 -Delete         # also delete the old folder after the check passes
#   .\scripts\move-data.ps1 -From "C:\x\ADBoard" -To "D:\ADBoard-data"
#
# Stop ADBoard first. The script refuses to run while ADBoard.exe is running.
# `temp` (scratch space) is not copied. -Delete removes the whole old folder,
# temp included, but only after every copied file matches.

[CmdletBinding()]
param(
    [string]$From = (Join-Path $env:LOCALAPPDATA "ADBoard"),
    [string]$To = (Join-Path $PSScriptRoot "..\dist\windows\adboard-data"),
    [switch]$Delete,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$From = [System.IO.Path]::GetFullPath($From).TrimEnd('\')
$To = [System.IO.Path]::GetFullPath($To).TrimEnd('\')

function Fail([string]$Message) {
    Write-Host "STOPPED: $Message" -ForegroundColor Red
    exit 1
}

if (Get-Process -Name ADBoard -ErrorAction SilentlyContinue) {
    Fail "ADBoard is running. Close it first, then run this again."
}
if (-not (Test-Path -LiteralPath $From -PathType Container)) {
    Fail "Nothing to move: $From does not exist."
}
if ($To.StartsWith("$From\", [StringComparison]::OrdinalIgnoreCase) -or $From.StartsWith("$To\", [StringComparison]::OrdinalIgnoreCase) -or $To -eq $From) {
    Fail "The two folders overlap. Choose a different -To."
}
if (Test-Path -LiteralPath $To) {
    $others = Get-ChildItem -LiteralPath $To -Force | Where-Object { $_.Name -ne "temp" }
    if ($others) {
        Fail "$To is not empty. Choose an empty folder (or one with only temp\)."
    }
}

# Every file to copy, as a path relative to $From (skips the top-level temp folder).
$files = Get-ChildItem -LiteralPath $From -Recurse -File -Force |
    Where-Object { $_.FullName.Substring($From.Length + 1) -notlike "temp\*" }
$total = ($files | Measure-Object -Property Length -Sum)
Write-Host "Copying $($files.Count) files ($([math]::Round($total.Sum / 1KB, 1)) KB) from $From"
Write-Host "          to $To"

foreach ($file in $files) {
    $relative = $file.FullName.Substring($From.Length + 1)
    $target = Join-Path $To $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
}

# Check: same file count, same sizes, same SHA-256 for every file.
$copied = Get-ChildItem -LiteralPath $To -Recurse -File -Force |
    Where-Object { $_.FullName.Substring($To.Length + 1) -notlike "temp\*" }
if ($copied.Count -ne $files.Count) {
    Fail "Copied $($copied.Count) files but expected $($files.Count). The old folder was not changed."
}
$bad = @()
foreach ($file in $files) {
    $relative = $file.FullName.Substring($From.Length + 1)
    $target = Join-Path $To $relative
    if (-not (Test-Path -LiteralPath $target)) { $bad += $relative; continue }
    $a = Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256
    $b = Get-FileHash -LiteralPath $target -Algorithm SHA256
    if ($a.Hash -ne $b.Hash) { $bad += $relative }
}
if ($bad.Count -gt 0) {
    Write-Host "These files did not match:" -ForegroundColor Red
    $bad | ForEach-Object { Write-Host "  $_" }
    Fail "The copy is not complete. The old folder was not changed; nothing was deleted."
}
Write-Host "Check passed: all $($files.Count) files match (SHA-256)." -ForegroundColor Green

if (-not $Delete) {
    Write-Host "Old folder kept: $From"
    Write-Host "Run again with -Delete to remove it, or delete it yourself after checking the data."
    exit 0
}

if (-not $Force) {
    $answer = Read-Host "Type DELETE to remove the old folder $From"
    if ($answer -ne "DELETE") {
        Write-Host "Not deleted. Old folder kept: $From"
        exit 0
    }
}
Remove-Item -LiteralPath $From -Recurse -Force
Write-Host "Deleted the old folder: $From" -ForegroundColor Green
Write-Host "Start ADBoard now. It uses $To because the data is there."

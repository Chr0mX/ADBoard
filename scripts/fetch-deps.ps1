# Download ADB + scrcpy into ./temp/, install into dist/windows/vendor/.
# Usage (PowerShell, from repo root):
#   .\scripts\fetch-deps.ps1
#   .\scripts\fetch-deps.ps1 -Force
#   .\scripts\fetch-deps.ps1 -Target all

[CmdletBinding()]
param(
    [ValidateSet("windows", "linux", "all")]
    [string]$Target = "windows",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TempDir = Join-Path $Root "temp"
$ScrcpyRepo = "Genymobile/scrcpy"

function Write-Step([string]$Message) { Write-Host "+ $Message" }

function Test-FileOk([string]$Path) {
    return (Test-Path -LiteralPath $Path -PathType Leaf) -and ((Get-Item -LiteralPath $Path).Length -gt 0)
}

function Get-Download([string]$Url, [string]$Dest) {
    $dir = Split-Path -Parent $Dest
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if ((Test-FileOk $Dest) -and -not $Force) {
        Write-Step "cache hit: $Dest"
        return
    }
    Write-Step "download: $Url"
    $partial = "$Dest.partial"
    Invoke-WebRequest -Uri $Url -OutFile $partial
    Move-Item -Force $partial $Dest
}

function Expand-ArchiveClean([string]$Zip, [string]$Dest) {
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Expand-Archive -Path $Zip -DestinationPath $Dest -Force
}

function Get-LatestScrcpyTag {
    if ($env:SCRCPY_VERSION) {
        $v = $env:SCRCPY_VERSION.TrimStart("v")
        return "v$v"
    }
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$ScrcpyRepo/releases/latest"
    return $rel.tag_name
}

function Install-WindowsAdb {
    $destDir = Join-Path $Root "dist\windows\vendor\adb"
    $adb = Join-Path $destDir "adb.exe"
    if ((Test-FileOk $adb) -and -not $Force) {
        Write-Step "skip windows adb (present): $adb"
        return
    }
    $zip = Join-Path $TempDir "downloads\platform-tools-windows.zip"
    $extract = Join-Path $TempDir "extract\platform-tools-windows"
    Get-Download "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" $zip
    Expand-ArchiveClean $zip $extract
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Copy-Item -Force (Join-Path $extract "platform-tools\adb.exe") $adb
    foreach ($f in @("AdbWinApi.dll", "AdbWinUsbApi.dll")) {
        $src = Join-Path $extract "platform-tools\$f"
        if (Test-Path $src) { Copy-Item -Force $src (Join-Path $destDir $f) }
    }
    Write-Step "installed windows adb → $adb"
}

function Install-WindowsScrcpy {
    $destDir = Join-Path $Root "dist\windows\vendor\scrcpy"
    $bin = Join-Path $destDir "scrcpy.exe"
    $tag = Get-LatestScrcpyTag
    $ver = $tag.TrimStart("v")
    $versionFile = Join-Path $destDir ".version"
    if ((Test-FileOk $bin) -and (Test-Path $versionFile) -and ((Get-Content $versionFile -Raw).Trim() -eq $ver) -and -not $Force) {
        Write-Step "skip windows scrcpy (present $ver): $bin"
        return
    }
    $asset = "scrcpy-win64-$tag.zip"
    $zip = Join-Path $TempDir "downloads\$asset"
    $extract = Join-Path $TempDir "extract\scrcpy-win64-$ver"
    Get-Download "https://github.com/$ScrcpyRepo/releases/download/$tag/$asset" $zip
    Expand-ArchiveClean $zip $extract
    $nested = Get-ChildItem -Directory $extract | Where-Object { $_.Name -like "scrcpy-win64-*" } | Select-Object -First 1
    if (-not $nested) { throw "scrcpy windows archive layout unexpected under $extract" }
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Get-ChildItem -Force $destDir | Where-Object { $_.Name -notin @("README.md", ".gitkeep") } | Remove-Item -Recurse -Force
    Copy-Item -Force -Recurse (Join-Path $nested.FullName "*") $destDir
    $server = Join-Path $destDir "scrcpy-server"
    if (-not (Test-Path $server)) {
        $found = Get-ChildItem -File $destDir | Where-Object { $_.Name -like "scrcpy-server*" } | Select-Object -First 1
        if ($found) { Copy-Item -Force $found.FullName $server }
    }
    Set-Content -Path $versionFile -Value $ver -NoNewline
    if (-not (Test-FileOk $bin)) { throw "windows scrcpy binary missing after install: $bin" }
    Write-Step "installed windows scrcpy $ver → $destDir"
}

New-Item -ItemType Directory -Force -Path (Join-Path $TempDir "downloads") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TempDir "extract") | Out-Null
Write-Step "temp cache: $TempDir"
Write-Step "target: $Target"

$targets = if ($Target -eq "all") { @("windows") } else { @($Target) }
# Linux packs need bash/tar; on native Windows we only fetch windows vendor.
if ($Target -eq "linux" -or $Target -eq "all") {
    Write-Host "! Linux packs: run scripts/fetch-deps.sh (or make fetch-deps) from WSL/Linux."
}

foreach ($t in $targets) {
    if ($t -eq "windows") {
        Install-WindowsAdb
        Install-WindowsScrcpy
    }
}

Write-Step "done. Cache under .\temp\; Windows binaries under dist\windows\vendor\."

<#
Purpose: Update the installed ARCANOS daemon from the workspace daemon-python (so deploy matches the codebase).
  .env.example and assets: always from daemon-python.
  ARCANOS.exe: from daemon-python\dist_new, else daemon-install-staging.
  unins000.exe / unins000.dat: from staging only if present (Inno Setup output).
.NOTES: Run as Administrator when InstallRoot is C:\Program Files\ARCANOS.
       unins000.exe and unins000.dat: compile installer\ARCANOS.iss and re-run ARCANOS-Setup.exe to update.
#>
param(
    [string]$SourceRoot,
    [string]$InstallRoot = "C:\Program Files\ARCANOS"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrEmpty($SourceRoot)) {
    $SourceRoot = Join-Path $PSScriptRoot "daemon-install-staging"
}
$daemonPython = Join-Path $repoRoot "daemon-python"

if (-not (Test-Path -LiteralPath $InstallRoot)) {
    throw "InstallRoot not found: $InstallRoot"
}

# Codebase: .env.example and assets from workspace daemon-python
$sourceEnv = Join-Path $daemonPython ".env.example"
$sourceAssets = Join-Path $daemonPython "assets"
if (-not (Test-Path -LiteralPath $sourceEnv)) { throw "daemon .env.example not found: $sourceEnv" }
if (-not (Test-Path -LiteralPath $sourceAssets)) { throw "daemon assets not found: $sourceAssets" }

# ARCANOS.exe: prefer daemon-python\dist_new, else SourceRoot (staging)
$sourceExe = Join-Path $daemonPython "dist_new\ARCANOS.exe"
if (-not (Test-Path -LiteralPath $sourceExe) -and (Test-Path -LiteralPath $SourceRoot)) {
    $sourceExe = Join-Path $SourceRoot "ARCANOS.exe"
}
if (-not (Test-Path -LiteralPath $sourceExe)) {
    throw "ARCANOS.exe not found in daemon-python\dist_new or daemon-install-staging. Run daemon-python\build_windows.ps1 first."
}

# unins000: optional, from SourceRoot (staging) only
$sourceUninsExe = Join-Path $SourceRoot "unins000.exe"
$sourceUninsDat = Join-Path $SourceRoot "unins000.dat"

$installExe = Join-Path $InstallRoot "ARCANOS.exe"
$installEnv = Join-Path $InstallRoot ".env.example"
$installAssets = Join-Path $InstallRoot "assets"
$installUninsExe = Join-Path $InstallRoot "unins000.exe"
$installUninsDat = Join-Path $InstallRoot "unins000.dat"

Copy-Item -Force $sourceExe $installExe
Copy-Item -Force $sourceEnv $installEnv
if (-not (Test-Path -LiteralPath $installAssets)) {
    # //audit Assumption: assets directory may be missing; risk: copy failure; invariant: directory exists; strategy: create.
    New-Item -ItemType Directory -Force -Path $installAssets | Out-Null
}
Copy-Item -Recurse -Force (Join-Path $sourceAssets "*") $installAssets

if (Test-Path -LiteralPath $sourceUninsExe) {
    # //audit Assumption: unins000.exe exists in staging; risk: mismatched installer metadata; invariant: copy if present; strategy: copy.
    Copy-Item -Force $sourceUninsExe $installUninsExe
} else {
    # //audit Assumption: uninstall exe not staged; risk: installer mismatch; invariant: skip copy; strategy: warn.
    Write-Host "Skipping unins000.exe (not present in SourceRoot)." -ForegroundColor Yellow
}

if (Test-Path -LiteralPath $sourceUninsDat) {
    # //audit Assumption: unins000.dat exists in staging; risk: mismatched installer metadata; invariant: copy if present; strategy: copy.
    Copy-Item -Force $sourceUninsDat $installUninsDat
} else {
    # //audit Assumption: uninstall dat not staged; risk: installer mismatch; invariant: skip copy; strategy: warn.
    Write-Host "Skipping unins000.dat (not present in SourceRoot)." -ForegroundColor Yellow
}

Write-Host "Updated ARCANOS installation at $InstallRoot" -ForegroundColor Green

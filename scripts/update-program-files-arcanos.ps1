<#
.SYNOPSIS
  Update C:\Program Files\ARCANOS with files from the codebase (and optional built ARCANOS.exe).
.DESCRIPTION
  Copies .env.example, assets, and ARCANOS.exe from the repo to C:\Program Files\ARCANOS.
  Must be run as Administrator to write to Program Files.
  unins000.exe and unins000.dat are produced by Inno Setup when you run ARCANOS-Setup.exe;
  to update those, rebuild the installer (compile installer\ARCANOS.iss) and re-run ARCANOS-Setup.exe.
.PARAMETER SourceRoot
  Root for .env.example and assets (default: daemon-python). ARCANOS.exe is taken from
  daemon-python\dist_new or from SourceRoot if no dist_new.
.EXAMPLE
  Run as Administrator:
  powershell -ExecutionPolicy Bypass -File scripts\update-program-files-arcanos.ps1
#>
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$daemonPython = Join-Path $repoRoot "daemon-python"
$installRoot = "C:\Program Files\ARCANOS"

if (-not (Test-Path -LiteralPath $installRoot)) {
    throw "Install root not found: $installRoot. Install ARCANOS first."
}

# .env.example and assets from daemon-python (source of truth for the daemon)
$envExample = Join-Path $daemonPython ".env.example"
$assetsSrc = Join-Path $daemonPython "assets"
if (-not (Test-Path -LiteralPath $envExample)) { throw "Not found: $envExample" }
if (-not (Test-Path -LiteralPath $assetsSrc)) { throw "Not found: $assetsSrc" }

Copy-Item -Path $envExample -Destination (Join-Path $installRoot ".env.example") -Force
Write-Host "Updated .env.example" -ForegroundColor Green

$assetsDest = Join-Path $installRoot "assets"
if (-not (Test-Path -LiteralPath $assetsDest)) {
    New-Item -ItemType Directory -Force -Path $assetsDest | Out-Null
}
Copy-Item -Path (Join-Path $assetsSrc "*") -Destination $assetsDest -Recurse -Force
Write-Host "Updated assets" -ForegroundColor Green

# ARCANOS.exe: prefer daemon-python\dist_new, else daemon-install-staging
$exeSrc = Join-Path $daemonPython "dist_new\ARCANOS.exe"
if (-not (Test-Path -LiteralPath $exeSrc)) {
    $exeSrc = Join-Path $repoRoot "scripts\daemon-install-staging\ARCANOS.exe"
}
if (Test-Path -LiteralPath $exeSrc) {
    Copy-Item -Path $exeSrc -Destination (Join-Path $installRoot "ARCANOS.exe") -Force
    Write-Host "Updated ARCANOS.exe" -ForegroundColor Green
} else {
    Write-Host "ARCANOS.exe not found in dist_new or daemon-install-staging; run daemon-python\build_windows.ps1 first. Skipping." -ForegroundColor Yellow
}

# unins000.exe / unins000.dat: produced by Inno Setup when ARCANOS-Setup.exe runs.
# To update: compile installer\ARCANOS.iss and re-run ARCANOS-Setup.exe.
Write-Host "`nDone. unins000.exe and unins000.dat: rebuild and re-run ARCANOS-Setup.exe to update." -ForegroundColor Cyan

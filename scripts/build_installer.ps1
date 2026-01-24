#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build the ARCANOS installer with Inno Setup.

.DESCRIPTION
    Builds the daemon executable (unless skipped) and compiles the installer script.

.PARAMETER InnoSetupCompilerPath
    Optional path to ISCC.exe. Falls back to INNO_SETUP_COMPILER env var or default install path.

.PARAMETER SkipBuild
    Skip building the daemon executable if it already exists.
#>

param(
    [string]$InnoSetupCompilerPath = "",
    [switch]$SkipBuild
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$installerScript = Join-Path $projectRoot "installer\ARCANOS.iss"
$defaultInnoPath = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
$localInnoPath = Join-Path $env:LOCALAPPDATA "Programs\\Inno Setup 6\\ISCC.exe"

# //audit assumption: compiler path can be provided; risk: missing compiler; invariant: resolved path; strategy: fallback chain.
$resolvedInnoPath = $InnoSetupCompilerPath
if (-not $resolvedInnoPath) {
    $resolvedInnoPath = $env:INNO_SETUP_COMPILER
}
if (-not $resolvedInnoPath -or -not (Test-Path $resolvedInnoPath)) {
    $resolvedInnoPath = $localInnoPath
}
if (-not $resolvedInnoPath -or -not (Test-Path $resolvedInnoPath)) {
    $resolvedInnoPath = $defaultInnoPath
}

if (-not (Test-Path $resolvedInnoPath)) {
    # //audit assumption: compiler must exist; risk: installer build blocked; invariant: path exists; strategy: exit with error.
    Write-Host "Inno Setup compiler not found at: $resolvedInnoPath" -ForegroundColor Red
    Write-Host "Set -InnoSetupCompilerPath or INNO_SETUP_COMPILER env var." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $installerScript)) {
    # //audit assumption: installer script must exist; risk: build failure; invariant: script path exists; strategy: exit with error.
    Write-Host "Installer script not found: $installerScript" -ForegroundColor Red
    exit 1
}

if (-not $SkipBuild) {
    # //audit assumption: daemon exe must be built first; risk: missing artifact; invariant: build runs; strategy: call daemon-python/build_windows.ps1.
    $daemonBuild = Join-Path $projectRoot "daemon-python\build_windows.ps1"
    if (-not (Test-Path $daemonBuild)) {
        Write-Host "Daemon build script not found: $daemonBuild" -ForegroundColor Red
        exit 1
    }
    Push-Location (Join-Path $projectRoot "daemon-python")
    try {
        & .\build_windows.ps1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Daemon build failed. Aborting installer build." -ForegroundColor Red
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

Write-Host "Building installer with Inno Setup..." -ForegroundColor Cyan
& $resolvedInnoPath $installerScript
if ($LASTEXITCODE -ne 0) {
    # //audit assumption: installer compile failures are fatal; risk: incomplete release; invariant: exit on failure; strategy: stop.
    Write-Host "Installer build failed." -ForegroundColor Red
    exit $LASTEXITCODE
}

$outputPath = Join-Path $projectRoot "installer\dist\ARCANOS-Setup.exe"
Write-Host "Installer created: $outputPath" -ForegroundColor Green

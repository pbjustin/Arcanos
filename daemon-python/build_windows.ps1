# Build Windows executables for ARCANOS daemon
# Uses PyInstaller to create standalone .exe files

Write-Host "Building ARCANOS daemon Windows executables..." -ForegroundColor Cyan

# Check if PyInstaller is installed; use python -m for reliability when pyinstaller not on PATH
$pyinstallerInstalled = python -m pip show pyinstaller 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing PyInstaller..." -ForegroundColor Yellow
    python -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install PyInstaller" -ForegroundColor Red
        exit 1
    }
}

# Build in %TEMP% to avoid AV locking files in the project (WinError 5 on os.remove)
$daemonRoot = (Get-Location).Path
$tmpBuild = Join-Path $env:TEMP "arcanos_pyinstall_$([guid]::NewGuid().ToString('N').Substring(0,8))"
Write-Host "Building in temp: $tmpBuild" -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $tmpBuild | Out-Null
# Copy source (exclude previous build dirs to speed up)
$exclude = @('dist','dist_new','build','build_pyi')
Get-ChildItem -Path $daemonRoot -Force | Where-Object { $_.Name -notin $exclude } | Copy-Item -Destination $tmpBuild -Recurse -Force -ErrorAction SilentlyContinue

Push-Location $tmpBuild
try {
    Write-Host "Building ARCANOS.exe using arcanos.spec..." -ForegroundColor Cyan
    python -m PyInstaller arcanos.spec --workpath=build_pyi --distpath=dist_new
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to build ARCANOS.exe" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

# Copy result back to project
$tmpDist = Join-Path $tmpBuild "dist_new"
if (Test-Path (Join-Path $tmpDist "ARCANOS.exe")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $daemonRoot "dist_new") | Out-Null
    Copy-Item -Path (Join-Path $tmpDist "*") -Destination (Join-Path $daemonRoot "dist_new") -Recurse -Force
    Copy-Item (Join-Path $daemonRoot "dist_new\ARCANOS.exe") (Join-Path $daemonRoot "dist_new\daemon.exe") -Force
    Copy-Item (Join-Path $daemonRoot "dist_new\ARCANOS.exe") (Join-Path $daemonRoot "dist_new\cli.exe") -Force
} else {
    Write-Host "ARCANOS.exe not found after build" -ForegroundColor Red
    Remove-Item -Recurse -Force $tmpBuild -ErrorAction SilentlyContinue
    exit 1
}
Remove-Item -Recurse -Force $tmpBuild -ErrorAction SilentlyContinue

# Verify
Write-Host "`nVerifying build outputs..." -ForegroundColor Cyan
$size = (Get-Item (Join-Path $daemonRoot "dist_new\ARCANOS.exe")).Length / 1MB
Write-Host ("OK ARCANOS.exe built successfully (" + [math]::Round($size, 2) + " MB)") -ForegroundColor Green
Write-Host "`nBuild complete! Executables are in dist_new/." -ForegroundColor Green

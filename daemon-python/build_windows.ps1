# Build Windows executables for ARCANOS daemon
# Uses PyInstaller to create standalone .exe files

Write-Host "Building ARCANOS daemon Windows executables..." -ForegroundColor Cyan

# Check if PyInstaller is installed
$pyinstallerInstalled = pip show pyinstaller 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing PyInstaller..." -ForegroundColor Yellow
    pip install pyinstaller
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install PyInstaller" -ForegroundColor Red
        exit 1
    }
}

# Clean previous builds
if (Test-Path "dist") {
    Write-Host "Cleaning previous build..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force dist
}
if (Test-Path "build") {
    Remove-Item -Recurse -Force build
}

# Build using the spec file (handles dependencies better)
Write-Host "Building ARCANOS.exe using arcanos.spec..." -ForegroundColor Cyan
pyinstaller --clean arcanos.spec

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build ARCANOS.exe" -ForegroundColor Red
    exit 1
}

# The spec creates ARCANOS.exe; copy to daemon.exe and cli.exe for dev/CLI use
if (Test-Path "dist\ARCANOS.exe") {
    Copy-Item "dist\ARCANOS.exe" "dist\daemon.exe" -Force
    Copy-Item "dist\ARCANOS.exe" "dist\cli.exe" -Force
    Write-Host "Created daemon.exe and cli.exe from ARCANOS.exe" -ForegroundColor Green
} else {
    Write-Host "ARCANOS.exe not found after build" -ForegroundColor Red
    exit 1
}

# Verify outputs (ARCANOS.exe already verified above; else is unreachable)
Write-Host "`nVerifying build outputs..." -ForegroundColor Cyan
$size = (Get-Item "dist\ARCANOS.exe").Length / 1MB
Write-Host "✓ ARCANOS.exe built successfully ($([math]::Round($size, 2)) MB)" -ForegroundColor Green

if (Test-Path "dist\daemon.exe") {
    Write-Host "✓ daemon.exe" -ForegroundColor Green
}
if (Test-Path "dist\cli.exe") {
    Write-Host "✓ cli.exe" -ForegroundColor Green
}

Write-Host "`nBuild complete! Executables are in the dist/ directory." -ForegroundColor Green

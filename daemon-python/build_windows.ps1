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
Write-Host "Building daemon.exe using arcanos.spec..." -ForegroundColor Cyan
python -m PyInstaller --clean arcanos.spec

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build daemon.exe" -ForegroundColor Red
    exit 1
}

# The spec file creates daemon.exe, also create cli.exe (same executable)
if (Test-Path "dist\daemon.exe") {
    Copy-Item "dist\daemon.exe" "dist\cli.exe" -Force
    Write-Host "Created cli.exe from daemon.exe" -ForegroundColor Green
} else {
    Write-Host "daemon.exe not found after build" -ForegroundColor Red
    exit 1
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build cli.exe" -ForegroundColor Red
    exit 1
}

# Verify outputs
Write-Host "`nVerifying build outputs..." -ForegroundColor Cyan
if (Test-Path "dist\daemon.exe") {
    $size = (Get-Item "dist\daemon.exe").Length / 1MB
    $sizeRounded = [math]::Round($size, 2)
    Write-Host "daemon.exe built successfully ($sizeRounded MB)" -ForegroundColor Green
} else {
    Write-Host "daemon.exe not found" -ForegroundColor Red
    exit 1
}

if (Test-Path "dist\cli.exe") {
    $size = (Get-Item "dist\cli.exe").Length / 1MB
    $sizeRounded = [math]::Round($size, 2)
    Write-Host "cli.exe built successfully ($sizeRounded MB)" -ForegroundColor Green
} else {
    Write-Host "cli.exe not found" -ForegroundColor Red
    exit 1
}

Write-Host "`nBuild complete! Executables are in the dist/ directory." -ForegroundColor Green

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
Write-Host "Building executables using arcanos.spec..." -ForegroundColor Cyan
pyinstaller --clean arcanos.spec

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build executables" -ForegroundColor Red
    exit 1
}

# The spec file creates ARCANOS.exe, rename/copy as needed
if (Test-Path "dist\ARCANOS.exe") {
    # Copy ARCANOS.exe to both daemon.exe and cli.exe
    Copy-Item "dist\ARCANOS.exe" "dist\daemon.exe" -Force
    Copy-Item "dist\ARCANOS.exe" "dist\cli.exe" -Force
    Write-Host "Created daemon.exe and cli.exe from ARCANOS.exe" -ForegroundColor Green
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build cli.exe" -ForegroundColor Red
    exit 1
}

# Verify outputs
Write-Host "`nVerifying build outputs..." -ForegroundColor Cyan
if (Test-Path "dist\daemon.exe") {
    $size = (Get-Item "dist\daemon.exe").Length / 1MB
    Write-Host "✓ daemon.exe built successfully ($([math]::Round($size, 2)) MB)" -ForegroundColor Green
} else {
    Write-Host "✗ daemon.exe not found" -ForegroundColor Red
    exit 1
}

if (Test-Path "dist\cli.exe") {
    $size = (Get-Item "dist\cli.exe").Length / 1MB
    Write-Host "✓ cli.exe built successfully ($([math]::Round($size, 2)) MB)" -ForegroundColor Green
} else {
    Write-Host "✗ cli.exe not found" -ForegroundColor Red
    exit 1
}

Write-Host "`nBuild complete! Executables are in the dist/ directory." -ForegroundColor Green

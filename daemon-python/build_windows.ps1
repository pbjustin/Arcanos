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

# Build daemon.exe
Write-Host "Building daemon.exe..." -ForegroundColor Cyan
pyinstaller --name daemon --onefile --console --specpath . --distpath dist --workpath build `
    --add-data "memory;memory" `
    --add-data "assets;assets" `
    --hidden-import=config `
    --hidden-import=backend_client `
    --hidden-import=backend_auth_client `
    --hidden-import=daemon_service `
    --hidden-import=env_store `
    --hidden-import=schema `
    cli.py

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build daemon.exe" -ForegroundColor Red
    exit 1
}

# Rename to daemon.exe if needed (PyInstaller creates cli.exe from cli.py)
if (Test-Path "dist\cli.exe") {
    if (Test-Path "dist\daemon.exe") {
        Remove-Item "dist\daemon.exe"
    }
    Rename-Item "dist\cli.exe" "daemon.exe"
}

# Build cli.exe (if needed separately)
Write-Host "Building cli.exe..." -ForegroundColor Cyan
pyinstaller --name cli --onefile --console --specpath . --distpath dist --workpath build `
    --add-data "memory;memory" `
    --add-data "assets;assets" `
    --hidden-import=config `
    --hidden-import=backend_client `
    --hidden-import=backend_auth_client `
    --hidden-import=env_store `
    --hidden-import=schema `
    cli.py

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

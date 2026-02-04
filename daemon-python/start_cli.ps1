# ARCANOS CLI Agent Launcher
# Opens the CLI agent in a new PowerShell window

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonPath = Join-Path $scriptPath ".venv\Scripts\python.exe"
$cliModule = "arcanos.cli"

if (Test-Path $pythonPath) {
    Write-Host "Starting ARCANOS CLI Agent..." -ForegroundColor Cyan
    Write-Host "Backend: https://acranos-production.up.railway.app" -ForegroundColor Green
    Write-Host ""
    
    # Start in new window
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$scriptPath'; `$env:PYTHONIOENCODING='utf-8'; & '$pythonPath' -m $cliModule"
} else {
    Write-Host "Error: Python not found at $pythonPath" -ForegroundColor Red
    Write-Host "Please ensure the virtual environment is set up correctly." -ForegroundColor Yellow
}

# ARCANOS CLI Debug Server Startup Script
# This script starts the ARCANOS CLI with debug server enabled for validation/testing

$ErrorActionPreference = "Stop"

# Set debug environment variables for this session only
$env:IDE_AGENT_DEBUG = "true"
$env:DAEMON_DEBUG_PORT = "9999"

# Set longer intervals to reduce backend load (helpful if backend is rate-limited by GitHub)
# These can be adjusted if needed - longer intervals = fewer requests = less rate limiting
$env:DAEMON_HEARTBEAT_INTERVAL_SECONDS = "60"  # Heartbeat every 60 seconds (was 30)
$env:DAEMON_COMMAND_POLL_INTERVAL_SECONDS = "30"  # Poll commands every 30 seconds (was 10)

Write-Host "Starting ARCANOS CLI with debug server enabled..." -ForegroundColor Green
Write-Host "  IDE_AGENT_DEBUG=$env:IDE_AGENT_DEBUG" -ForegroundColor Cyan
Write-Host "  DAEMON_DEBUG_PORT=$env:DAEMON_DEBUG_PORT" -ForegroundColor Cyan
Write-Host ""
Write-Host "Debug server will be available at: http://127.0.0.1:$env:DAEMON_DEBUG_PORT" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop the CLI agent" -ForegroundColor Yellow
Write-Host ""

# Change to the daemon-python directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Start the CLI
python -m arcanos.cli

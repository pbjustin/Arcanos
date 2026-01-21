$rootDir = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $rootDir "backend-typescript"
$daemonDir = Join-Path $rootDir "daemon-python"

$port = if ($env:PORT) { $env:PORT } else { "5000" }
$healthUrl = if ($env:ARCANOS_BACKEND_HEALTH_URL) { $env:ARCANOS_BACKEND_HEALTH_URL } else { "http://localhost:$port/api/health" }
$maxWaitSeconds = if ($env:ARCANOS_BACKEND_WAIT_SECONDS) { [int]$env:ARCANOS_BACKEND_WAIT_SECONDS } else { 30 }

Write-Host "Starting backend (dev mode)..."
$backendProcess = Start-Process -FilePath "npm" -ArgumentList "--prefix", $backendDir, "run", "dev" -PassThru

Write-Host "Waiting for backend health check at $healthUrl..."
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
while ($stopwatch.Elapsed.TotalSeconds -lt $maxWaitSeconds) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2 | Out-Null
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}

Write-Host "Starting daemon..."
$daemonProcess = Start-Process -FilePath "python" -ArgumentList "cli.py" -WorkingDirectory $daemonDir -PassThru

Write-Host "Press Ctrl+C to stop both."
try {
    Wait-Process -Id $backendProcess.Id, $daemonProcess.Id
} finally {
    if (!$backendProcess.HasExited) { $backendProcess.Kill() }
    if (!$daemonProcess.HasExited) { $daemonProcess.Kill() }
}

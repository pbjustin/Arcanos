param(
    [string]$Destination
)

# Simple backup script for ARCANOS data/state
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path $PSScriptRoot -Parent
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

if (-not $Destination -or $Destination.Trim() -eq "") {
    $Destination = Join-Path $projectRoot "backups\backup_$timestamp"
}

$staging = Join-Path $Destination "staging"
$zipPath = "$Destination.zip"

New-Item -ItemType Directory -Path $staging -Force | Out-Null

$items = @(
    "daemon-python\memories.json",
    "daemon-python\.env",
    "daemon-python\logs",
    "daemon-python\crash_reports",
    "daemon-python\telemetry",
    "daemon-python\screenshots"
)

foreach ($item in $items) {
    $source = Join-Path $projectRoot $item
    if (Test-Path $source) {
        Copy-Item $source $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Include metadata
$metadata = @{
    created_at = (Get-Date).ToString("o")
    project_root = $projectRoot
    items_included = $items | Where-Object { Test-Path (Join-Path $projectRoot $_) }
}
$metadata | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $staging "backup_metadata.json")

# Create zip archive
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force

# Clean staging
Remove-Item $staging -Recurse -Force

Write-Host "Backup created:" $zipPath

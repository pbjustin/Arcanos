# Backup ARCANOS workspace from C: to D:
# Run: powershell -ExecutionPolicy Bypass -File C:\arcanos-hybrid\scripts\backup-workspace-to-d.ps1

$timestamp = Get-Date -Format "yyyyMMdd"
$dest = "D:\arcanos-workspace-backup-$timestamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Write-Host "Backing up to $dest" -ForegroundColor Cyan

# Exclude large/reinstallable dirs to speed up; remove /XD for full backup
$exclude = @("node_modules", "venv", "dist", "build", "dist_new", "build_pyi", "__pycache__", ".next", ".nuxt")

foreach ($name in @("arcanos-hybrid","arcanos-hybrid-latest","arcanos-hybrid-sandbox")) {
    $src = "C:\$name"
    if (Test-Path $src) {
        Write-Host "Copying $name..." -ForegroundColor Yellow
        robocopy $src "$dest\$name" /E /COPY:DAT /R:2 /W:3 /MT:8 /XD $exclude
        if ($LASTEXITCODE -lt 8) { Write-Host "  $name done" -ForegroundColor Green } else { Write-Host "  $name - robocopy exit $LASTEXITCODE" -ForegroundColor Red }
    }
}

Write-Host "`nBackup complete: $dest" -ForegroundColor Green
Get-ChildItem $dest -Directory | ForEach-Object { $n = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count; Write-Host "  $($_.Name): $n files" }

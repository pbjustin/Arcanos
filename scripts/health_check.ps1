# Health check script for ARCANOS
$ErrorActionPreference = "SilentlyContinue"
$projectRoot = Split-Path $PSScriptRoot -Parent
$pythonVenv = Join-Path $projectRoot "daemon-python\venv\Scripts\python.exe"
$python = if (Test-Path $pythonVenv) { $pythonVenv } else { "python" }

function Write-Result {
    param([string]$Name, [string]$Status, [string]$Detail)
    $statusIcon = if ($Status -eq "OK") { "✅" } elseif ($Status -eq "WARN") { "⚠️" } else { "❌" }
    Write-Host ("{0} {1}: {2}" -f $statusIcon, $Name, $Detail)
}

# 1) Python availability
$pyVersion = & $python --version
if ($LASTEXITCODE -eq 0) {
    Write-Result "Python" "OK" $pyVersion
} else {
    Write-Result "Python" "FAIL" "Python not found"
}

# 2) Environment file
$envPath = Join-Path $projectRoot "daemon-python\.env"
if (Test-Path $envPath) {
    $envContent = Get-Content $envPath
    $hasApiKey = $envContent -match "^OPENAI_API_KEY="
    $masked = if ($hasApiKey) { "Present" } else { "Missing" }
    Write-Result ".env" "OK" ("OPENAI_API_KEY: {0}" -f $masked)
} else {
    Write-Result ".env" "WARN" ".env missing; copy from .env.example"
}

# 3) Memory file
$memoryPath = Join-Path $projectRoot "daemon-python\memories.json"
if (Test-Path $memoryPath) {
    try {
        $json = Get-Content $memoryPath -Raw | ConvertFrom-Json
        Write-Result "Memory" "OK" "memories.json loaded"
    } catch {
        Write-Result "Memory" "FAIL" "memories.json is corrupted"
    }
} else {
    $template = Join-Path $projectRoot "daemon-python\memory\bootstrap_template.json"
    Write-Result "Memory" "WARN" "Not found; restore from template: $template"
}

# 4) Backend health (optional)
$backendUrl = $envContent | Where-Object { $_ -match "^BACKEND_URL=" } | ForEach-Object { $_.Split('=')[1] }
if ($backendUrl) {
    try {
        $healthUrl = "$backendUrl/api/health"
        $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
        $status = "Status $($resp.StatusCode)"
        Write-Result "Backend" "OK" $status
    } catch {
        Write-Result "Backend" "FAIL" "Unreachable" 
    }
} else {
    Write-Result "Backend" "OK" "Not configured (local-only mode)"
}

# 5) Quick daemon import test
try {
    $code = "from config import Config; ok, msg = Config.validate(); print('OK' if ok else msg)"
    $result = & $python -c $code 2>&1
    if ($LASTEXITCODE -eq 0 -and $result -match "OK") {
        Write-Result "Daemon" "OK" "Config validated"
    } else {
        Write-Result "Daemon" "FAIL" "$result"
    }
} catch {
    Write-Result "Daemon" "FAIL" "Python dependencies missing"
}

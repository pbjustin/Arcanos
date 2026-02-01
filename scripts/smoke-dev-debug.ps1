param(
    [string]$BackendBaseUrl
)

$backendBase = if ($BackendBaseUrl) {
    $BackendBaseUrl
} elseif ($env:ARCANOS_BACKEND_URL) {
    $env:ARCANOS_BACKEND_URL
} elseif ($env:SERVER_URL) {
    $env:SERVER_URL
} elseif ($env:BACKEND_URL) {
    $env:BACKEND_URL
} else {
    'http://127.0.0.1:8080'
}

$debugPort = if ($env:DAEMON_DEBUG_PORT) { [int]$env:DAEMON_DEBUG_PORT } else { 9999 }
$bridgePort = if ($env:BRIDGE_PORT) { [int]$env:BRIDGE_PORT } else { 7777 }

$debugBase = "http://127.0.0.1:$debugPort"
$bridgeBase = "http://127.0.0.1:$bridgePort"

$secret = $env:ARCANOS_AUTOMATION_SECRET
if (-not $secret) {
    Write-Warning 'ARCANOS_AUTOMATION_SECRET is not set. Token issuance tests will be skipped.'
    return
}

$automationHeaderName = if ($env:ARCANOS_AUTOMATION_HEADER) { $env:ARCANOS_AUTOMATION_HEADER } else { 'x-arcanos-automation' }

function Request-ConfirmationToken {
    $headers = @{ 'Content-Type' = 'application/json' }
    $headers[$automationHeaderName] = $secret
    try {
        $resp = Invoke-RestMethod -Uri "$backendBase/debug/create-confirmation-token" -Method POST -Headers $headers -Body '{}' -UseBasicParsing -ErrorAction Stop
        return $resp
    } catch {
        Write-Error "Failed to request confirmation token: $_"
        return $null
    }
}

function Invoke-DebugStatus($token) {
    $headers = @{}
    if ($token) {
        $headers['x-arcanos-confirm-token'] = $token
    }
    try {
        $resp = Invoke-RestMethod -Uri "$debugBase/debug/status" -Method GET -Headers $headers -UseBasicParsing -ErrorAction Stop
        return $resp
    } catch {
        return $null
    }
}

Write-Host "Issuing one-time token from $backendBase" -ForegroundColor Cyan
$tokenResp = Request-ConfirmationToken
if (-not $tokenResp -or -not $tokenResp.token) {
    Write-Error 'Token issuance failed; aborting smoke tests.'
    exit 1
}

$token = $tokenResp.token
Write-Host "Token issued; expires at: $($tokenResp.expiresAt)" -ForegroundColor Green

Write-Host "Testing debug endpoint with token" -ForegroundColor Cyan
$debugOk = Invoke-DebugStatus $token
if ($null -eq $debugOk) {
    Write-Error 'Debug status failed with token.'
    exit 1
}
Write-Host 'Debug status succeeded with token.' -ForegroundColor Green

Write-Host 'Testing debug endpoint reuse (should fail)' -ForegroundColor Cyan
$debugReuse = Invoke-DebugStatus $token
if ($null -ne $debugReuse) {
    Write-Error 'Debug status unexpectedly succeeded with reused token.'
    exit 1
}
Write-Host 'Debug status correctly rejected reused token.' -ForegroundColor Green

Write-Host "Testing bridge status with a fresh token" -ForegroundColor Cyan
$bridgeTokenResp = Request-ConfirmationToken
if (-not $bridgeTokenResp -or -not $bridgeTokenResp.token) {
    Write-Warning 'Bridge token issuance failed; skipping bridge check.'
    return
}
$bridgeToken = $bridgeTokenResp.token

try {
    $bridgeHeaders = @{ 'x-arcanos-confirm-token' = $bridgeToken }
    $bridgeResp = Invoke-RestMethod -Uri "$bridgeBase/bridge-status" -Method GET -Headers $bridgeHeaders -UseBasicParsing -ErrorAction Stop
    Write-Host "Bridge status: $($bridgeResp.status)" -ForegroundColor Green
} catch {
    Write-Warning "Bridge status check failed: $_"
}

Write-Host 'Smoke tests completed.' -ForegroundColor Green

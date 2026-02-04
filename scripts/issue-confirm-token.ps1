param(
    [string]$BaseUrl
)

$defaultBase = 'http://127.0.0.1:8080'
$base = if ($BaseUrl) {
    $BaseUrl
} elseif ($env:ARCANOS_BACKEND_URL) {
    $env:ARCANOS_BACKEND_URL
} elseif ($env:SERVER_URL) {
    $env:SERVER_URL
} elseif ($env:BACKEND_URL) {
    $env:BACKEND_URL
} else {
    $defaultBase
}

$secret = $env:ARCANOS_AUTOMATION_SECRET
if (-not $secret) {
    Write-Error 'ARCANOS_AUTOMATION_SECRET is not set. Set it before requesting a one-time token.'
    exit 1
}

$headerName = if ($env:ARCANOS_AUTOMATION_HEADER) { $env:ARCANOS_AUTOMATION_HEADER } else { 'x-arcanos-automation' }
$headers = @{ 'Content-Type' = 'application/json' }
$headers[$headerName] = $secret

try {
    $response = Invoke-RestMethod -Uri "$base/debug/create-confirmation-token" -Method POST -Headers $headers -Body '{}' -UseBasicParsing -ErrorAction Stop
    if ($response.ok -and $response.token) {
        Write-Host "One-time confirmation token: $($response.token)"
        Write-Host "Expires at: $($response.expiresAt)"
    } else {
        Write-Error "Failed to create token: $($response | ConvertTo-Json -Depth 5)"
        exit 1
    }
} catch {
    Write-Error "Token request failed: $_"
    exit 1
}

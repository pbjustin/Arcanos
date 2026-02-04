
<#
.SYNOPSIS
A debug client for the ARCANOS daemon's local debug HTTP server.

.DESCRIPTION
This script provides commands to inspect and interact with a live ARCANOS daemon
instance that has its debug server enabled. Set IDE_AGENT_DEBUG=1 or DAEMON_DEBUG_PORT
in the daemon's .env file to enable the server.

.PARAMETER Command
The command to execute. Valid commands are:
- status: Get daemon status (instance ID, version, uptime, etc.).
- instance-id: Get the daemon's instance ID.
- chat-log: Retrieve the recent conversation history.
- logs: Tail the main daemon error log.
- log-files: List all available log files.
- audit: Show the recent activity/audit trail.
- see: Capture the screen and get a description. Use --camera to use the webcam.
- crash-reports: List crash reports and show the latest one.
- ask <message>: Send a message to the daemon's conversation handler.
- run <command>: Execute a shell command via the daemon.

.EXAMPLE
PS> .\daemon-debug.ps1 status
PS> .\daemon-debug.ps1 logs --tail 100
PS> .\daemon-debug.ps1 ask "What is your current status?"
PS> .\daemon-debug.ps1 run "Get-Process arcanos"
PS> .\daemon-debug.ps1 see
PS> .\daemon-debug.ps1 see --camera
#>
param (
    [Parameter(Mandatory=$true, Position=0)]
    [ValidateSet('status', 'instance-id', 'chat-log', 'logs', 'log-files', 'audit', 'see', 'crash-reports', 'ask', 'run')]
    [string]$Command,

    [Parameter(Position=1, ValueFromRemainingArguments=$true)]
    [string[]]$Arguments
)

# --- Configuration ---
$defaultPort = 9999
$port = if ($env:DAEMON_DEBUG_PORT) { [int]$env:DAEMON_DEBUG_PORT } else { $defaultPort }
$base = "http://127.0.0.1:$port"

# --- Helper Functions ---
function Invoke-DaemonRequest {
    param (
        [string]$Path,
        [string]$Method = 'GET',
        [object]$Body = $null
    )

    $uri = "$base$Path"
    $headers = @{ 'Content-Type' = 'application/json' }
    $automationSecret = $env:ARCANOS_AUTOMATION_SECRET
    $automationHeaderName = if ($env:ARCANOS_AUTOMATION_HEADER) { $env:ARCANOS_AUTOMATION_HEADER } else { 'x-arcanos-automation' }
    if ($automationSecret) {
        $headers[$automationHeaderName] = $automationSecret
    }
    
    $requestParams = @{
        Uri = $uri
        Method = $Method
        Headers = $headers
        UseBasicParsing = $true
        ErrorAction = 'Stop'
        TimeoutSec = 10
    }

    if ($Body) {
        $requestParams.Body = ($Body | ConvertTo-Json -Depth 5)
    }

    try {
        $response = Invoke-RestMethod @requestParams
        return $response
    }
    catch [System.Net.WebException] {
        Write-Error "Daemon debug server not available at '$uri'. Is ARCANOS running with IDE_AGENT_DEBUG=1 or DAEMON_DEBUG_PORT set?"
        exit 1
    }
    catch {
        Write-Error "An unexpected error occurred: $_"
        exit 1
    }
}

# --- Command Handlers ---
switch ($Command) {
    'status' {
        $response = Invoke-DaemonRequest -Path '/debug/status'
        $response | Format-Table
    }
    'instance-id' {
        $response = Invoke-DaemonRequest -Path '/debug/instance-id'
        $response | ConvertTo-Json
    }
    'chat-log' {
        $response = Invoke-DaemonRequest -Path '/debug/chat-log'
        if ($response.chat_log) {
            $response.chat_log | ForEach-Object {
                Write-Host "[$($_.timestamp)] $($_.role): $($_.message)"
            }
        }
        if ($response.last_error) {
            Write-Host "[LAST ERROR]: $($response.last_error)" -ForegroundColor Red
        }
    }
    'logs' {
        $tail = 50
        if ($Arguments) {
            $tailIndex = [array]::IndexOf($Arguments, '--tail')
            if ($tailIndex -ne -1 -and $Arguments.Length -gt ($tailIndex + 1)) {
                $tail = [int]$Arguments[$tailIndex + 1]
            }
        }
        $response = Invoke-DaemonRequest -Path "/debug/logs?tail=$tail"
        Write-Host "Log file: $($response.path)"
        $response.lines -join "`n" | Write-Host
        if ($response.error) {
             Write-Host "Error: $($response.error)" -ForegroundColor Yellow
        }
    }
    'log-files' {
        $response = Invoke-DaemonRequest -Path '/debug/log-files'
        Write-Host "Log directory: $($response.log_dir)"
        $response.files | Format-Table
    }
    'audit' {
        $limit = 100
        if ($Arguments) {
            $limitIndex = [array]::IndexOf($Arguments, '--limit')
            if ($limitIndex -ne -1 -and $Arguments.Length -gt ($limitIndex + 1)) {
                $limit = [int]$Arguments[$limitIndex + 1]
            }
        }
        $response = Invoke-DaemonRequest -Path "/debug/audit?limit=$limit"
        $response.entries | ForEach-Object {
            Write-Host "[$($_.ts)] [$($_.kind)] - $($_.detail)"
        }
    }
    'see' {
        $useCamera = $false
        if ($Arguments -contains '--camera') {
            $useCamera = $true
        }
        $body = @{ use_camera = $useCamera }
        $response = Invoke-DaemonRequest -Path '/debug/see' -Method 'POST' -Body $body
        if ($response.ok) {
            Write-Host $response.response_text
        } else {
            Write-Error "See command failed: $($response.error)"
        }
    }
    'crash-reports' {
        $response = Invoke-DaemonRequest -Path '/debug/crash-reports'
        Write-Host "Crash Reports:"
        $response.files | Format-Table
        if ($response.latest_content) {
            Write-Host "`n--- Latest Crash Report ---`n" -ForegroundColor Yellow
            Write-Host $response.latest_content
        } else {
            Write-Host "No crash reports found."
        }
    }
    'ask' {
        $message = $Arguments -join ' '
        if (-not $message) {
            Write-Error "Please provide a message for the 'ask' command."
            exit 1
        }
        $body = @{ message = $message }
        $response = Invoke-DaemonRequest -Path '/debug/ask' -Method 'POST' -Body $body
        if ($response.ok) {
            Write-Host $response.response_text
        } else {
            Write-Error "Ask command failed: $($response.error)"
        }
    }
    'run' {
        $commandToRun = $Arguments -join ' '
        if (-not $commandToRun) {
            Write-Error "Please provide a command for the 'run' command."
            exit 1
        }
        $body = @{ command = $commandToRun }
        $response = Invoke-DaemonRequest -Path '/debug/run' -Method 'POST' -Body $body
        if ($response.ok) {
            if ($response.stdout) { Write-Host $response.stdout }
            if ($response.stderr) { Write-Error $response.stderr }
            Write-Host "Exit Code: $($response.return_code)"
        } else {
            Write-Error "Run command failed: $($response.error)"
        }
    }
}

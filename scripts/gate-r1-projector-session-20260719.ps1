[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectorTokenName = 'ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN'
$ProjectId = '7faf44e5-519c-4e73-8d7a-da9f389e6187'
$EnvironmentId = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13'
$PrivateNetworkId = '464f2194-3825-4ac1-a705-192566561675'
$OriginalPostgresServiceId = 'b7789306-8aef-4113-add5-02883a6cc087'
$OriginalRedisServiceId = '434fa5b4-b52c-4caf-aaba-e87c173bf10d'
$PostgresServiceId = 'a2a57da4-a928-427f-be30-d4a68b59a117'
$RedisServiceId = '1ac0bd56-50b3-49eb-954c-ea83515ec915'
$PostgresName = 'phase2e-postgres-r2-20260718'
$RedisName = 'phase2e-redis-r2-20260718'
$PostgresR3ServiceId = '7346b3f6-bf3d-46e1-9d66-79f10847ef89'
$PostgresR3ServiceInstanceId = '86dde430-50ac-4d5c-95c3-cb27064eff51'
$PostgresR3Name = 'phase2e-postgres-r3-20260720'
$ProtocolVersion = 1
$MaximumRequests = 20
$RequestTimeoutSeconds = 2700
$AcknowledgementTimeoutSeconds = 300
$ChildTimeoutMilliseconds = 20000
$MaximumChildOutputBytes = 262144
$MaximumChildErrorBytes = 256
$MaximumRequestBytes = 4096

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$MetadataProjector = Join-Path $PSScriptRoot 'gate-r1-railway-metadata-projector.js'
$TcpProxyProjector = Join-Path $PSScriptRoot 'gate-r1-tcp-proxy-projector.js'
$MetadataProjectorSha256 = '6225B33CA2BE6A92A7F6B617AAE86B7043440B0EF26A8700C8E12F6F14108C6E'
$TcpProxyProjectorSha256 = 'E6B1EB138DA5734ECF429378E86C04F64936020ECAE4B4E9CD58F2E5703A256E'
$NodePath = 'C:\Program Files\nodejs\node.exe'
$NodeSha256 = 'D14BA95CDCE1EF7DC9AD3AC74949CA5DB38B27378EE30F30A23CF26F9E875A11'

function Throw-Safe([string]$Code) {
  throw [InvalidOperationException]::new($Code)
}

function Test-CanonicalUuid([object]$Value) {
  return $Value -is [string] -and $Value -cmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
}

function Assert-ExactKeys([hashtable]$Value, [string[]]$Expected) {
  $actual = @($Value.Keys | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID' }
  for ($index = 0; $index -lt $actual.Count; $index += 1) {
    if ($actual[$index] -cne $wanted[$index]) { Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID' }
  }
}

function Write-SafeJsonFile([string]$Path, [hashtable]$Value) {
  $json = $Value | ConvertTo-Json -Compress -Depth 12
  $directory = [IO.Path]::GetDirectoryName($Path)
  $temporaryPath = Join-Path $directory ('.gate-r1-write-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + [Environment]::NewLine)
    $stream = [IO.FileStream]::new(
      $temporaryPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::WriteThrough
    )
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    [IO.File]::Move($temporaryPath, $Path, $false)
  } finally {
    if ([IO.File]::Exists($temporaryPath)) {
      try { [IO.File]::Delete($temporaryPath) } catch {}
    }
  }
}

function Try-WriteSafeJsonFile([string]$Path, [hashtable]$Value) {
  try {
    if (-not [IO.File]::Exists($Path)) { Write-SafeJsonFile $Path $Value }
  } catch {}
}

function Read-BoundedJsonFile([string]$Path, [int]$MaximumBytes, [string]$FailureCode) {
  try {
    $item = [IO.FileInfo]::new($Path)
    if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Throw-Safe $FailureCode
    }
    $stream = [IO.FileStream]::new(
      $Path,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::SequentialScan
    )
    try {
      if ($stream.Length -le 0 -or $stream.Length -gt $MaximumBytes) { Throw-Safe $FailureCode }
      $bytes = [byte[]]::new([int]$stream.Length)
      $offset = 0
      while ($offset -lt $bytes.Length) {
        $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($read -le 0) { Throw-Safe $FailureCode }
        $offset += $read
      }
      if ($stream.ReadByte() -ne -1) { Throw-Safe $FailureCode }
    } finally {
      $stream.Dispose()
    }
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $json = $utf8.GetString($bytes)
    $value = $json | ConvertFrom-Json -AsHashtable -Depth 8
    if ($value -isnot [hashtable]) { Throw-Safe $FailureCode }
    return $value
  } catch {
    if ($_.Exception.Message -ceq $FailureCode) { throw }
    Throw-Safe $FailureCode
  }
}

function Resolve-SafeErrorCode([object]$ErrorRecord) {
  $exception = if ($ErrorRecord -is [Management.Automation.ErrorRecord]) {
    $ErrorRecord.Exception
  } elseif ($ErrorRecord -is [Exception]) {
    $ErrorRecord
  } else {
    $null
  }
  for ($depth = 0; $null -ne $exception -and $depth -lt 8; $depth += 1) {
    if ($exception.Message -cmatch '^GATE_R1_[A-Z0-9_]+$') { return $exception.Message }
    $exception = $exception.InnerException
  }
  return 'GATE_R1_SESSION_FAILED'
}

function Assert-FileHash([string]$Path, [string]$ExpectedHash, [string]$FailureCode) {
  if (-not [IO.File]::Exists($Path)) { Throw-Safe $FailureCode }
  try {
    $stream = [IO.FileStream]::new(
      $Path,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::Read,
      65536,
      [IO.FileOptions]::SequentialScan
    )
    try {
      $sha256 = [Security.Cryptography.SHA256]::Create()
      try { $actual = [Convert]::ToHexString($sha256.ComputeHash($stream)) } finally { $sha256.Dispose() }
    } finally {
      $stream.Dispose()
    }
  } catch {
    Throw-Safe $FailureCode
  }
  if ($actual -cne $ExpectedHash) { Throw-Safe $FailureCode }
}

function Get-ProjectorArguments([hashtable]$Request) {
  if ($Request.protocolVersion -ne $ProtocolVersion) { Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID' }
  switch -CaseSensitive ($Request.operation) {
    'environment' {
      Assert-ExactKeys $Request @('operation', 'protocolVersion', 'sequence')
      return @($MetadataProjector, '--environment')
    }
    'fixedProxy' {
      Assert-ExactKeys $Request @('operation', 'protocolVersion', 'sequence', 'serviceId')
      if ($Request.serviceId -cne $OriginalPostgresServiceId -and $Request.serviceId -cne $OriginalRedisServiceId) {
        Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID'
      }
      return @($TcpProxyProjector, '--service-id', [string]$Request.serviceId)
    }
    'replacementProxy' {
      Assert-ExactKeys $Request @('operation', 'profile', 'protocolVersion', 'sequence', 'serviceId', 'serviceInstanceId')
      if (-not (Test-CanonicalUuid $Request.serviceInstanceId)) {
        Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID'
      }
      if (
        ($Request.profile -ceq 'postgres' -and $Request.serviceId -ceq $PostgresServiceId) -or
        ($Request.profile -ceq 'redis' -and $Request.serviceId -ceq $RedisServiceId) -or
        (
          $Request.profile -ceq 'postgres-r3' -and
          $Request.serviceId -ceq $PostgresR3ServiceId -and
          $Request.serviceInstanceId -ceq $PostgresR3ServiceInstanceId
        )
      ) {
        return @(
          $TcpProxyProjector,
          '--replacement-profile', [string]$Request.profile,
          '--service-id', [string]$Request.serviceId,
          '--service-instance-id', [string]$Request.serviceInstanceId
        )
      }
      Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID'
    }
    'endpoint' {
      Assert-ExactKeys $Request @('operation', 'privateNetworkId', 'profile', 'protocolVersion', 'sequence', 'serviceId')
      if ($Request.privateNetworkId -cne $PrivateNetworkId) {
        Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID'
      }
      if ($Request.profile -ceq 'redis' -and $Request.serviceId -ceq $RedisServiceId) {
        $serviceName = $RedisName
      } elseif ($Request.profile -ceq 'postgres-r3' -and $Request.serviceId -ceq $PostgresR3ServiceId) {
        $serviceName = $PostgresR3Name
      } else {
        Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID'
      }
      return @(
        $MetadataProjector,
        '--endpoint',
        '--service-id', [string]$Request.serviceId,
        '--service-name', $serviceName,
        '--private-network-id', $PrivateNetworkId
      )
    }
    default {
      Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID'
    }
  }
}

function Assert-ExactProjectorInvocation([string[]]$Arguments) {
  if ($Arguments.Count -eq 2 -and $Arguments[0] -ceq $MetadataProjector -and $Arguments[1] -ceq '--environment') {
    return
  }
  if (
    $Arguments.Count -eq 3 -and
    $Arguments[0] -ceq $TcpProxyProjector -and
    $Arguments[1] -ceq '--service-id' -and
    ($Arguments[2] -ceq $OriginalPostgresServiceId -or $Arguments[2] -ceq $OriginalRedisServiceId)
  ) {
    return
  }
  if (
    $Arguments.Count -eq 8 -and
    $Arguments[0] -ceq $MetadataProjector -and
    $Arguments[1] -ceq '--endpoint' -and
    $Arguments[2] -ceq '--service-id' -and
    ($Arguments[3] -ceq $RedisServiceId -or $Arguments[3] -ceq $PostgresR3ServiceId) -and
    $Arguments[4] -ceq '--service-name' -and
    (
      ($Arguments[3] -ceq $RedisServiceId -and $Arguments[5] -ceq $RedisName) -or
      ($Arguments[3] -ceq $PostgresR3ServiceId -and $Arguments[5] -ceq $PostgresR3Name)
    ) -and
    $Arguments[6] -ceq '--private-network-id' -and
    $Arguments[7] -ceq $PrivateNetworkId
  ) {
    return
  }
  if (
    $Arguments.Count -eq 7 -and
    $Arguments[0] -ceq $TcpProxyProjector -and
    $Arguments[1] -ceq '--replacement-profile' -and
    $Arguments[3] -ceq '--service-id' -and
    $Arguments[5] -ceq '--service-instance-id' -and
    (Test-CanonicalUuid $Arguments[6]) -and
    (
      ($Arguments[2] -ceq 'postgres' -and $Arguments[4] -ceq $PostgresServiceId) -or
      ($Arguments[2] -ceq 'redis' -and $Arguments[4] -ceq $RedisServiceId) -or
      (
        $Arguments[2] -ceq 'postgres-r3' -and
        $Arguments[4] -ceq $PostgresR3ServiceId -and
        $Arguments[6] -ceq $PostgresR3ServiceInstanceId
      )
    )
  ) {
    return
  }
  Throw-Safe 'GATE_R1_SESSION_PROJECTOR_ARGUMENTS_INVALID'
}

function Initialize-BoundedProcessType {
  if ('Arcanos.GateR1.BoundedProcess' -as [type]) { return }
  try {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace Arcanos.GateR1 {
  public sealed class BoundedProcessResult {
    public int ExitCode { get; set; }
    public string StandardOutput { get; set; }
    public string StandardError { get; set; }
  }

  public static class BoundedProcess {
    private sealed class OutputLimitException : Exception { }

    private static byte[] ReadBounded(Stream stream, int maximumBytes, Process process) {
      using (var output = new MemoryStream(Math.Min(maximumBytes, 4096))) {
        var buffer = new byte[1024];
        var total = 0;
        while (true) {
          var read = stream.Read(buffer, 0, buffer.Length);
          if (read == 0) break;
          if (read > maximumBytes - total) {
            try { process.Kill(true); } catch { }
            throw new OutputLimitException();
          }
          output.Write(buffer, 0, read);
          total += read;
        }
        return output.ToArray();
      }
    }

    private static bool IsOutputLimit(AggregateException error) {
      foreach (var inner in error.Flatten().InnerExceptions) {
        if (inner is OutputLimitException) return true;
      }
      return false;
    }

    public static BoundedProcessResult CaptureStarted(
      Process process,
      int timeoutMilliseconds,
      int maximumOutputBytes,
      int maximumErrorBytes
    ) {
        if (process == null || !HasStarted(process)) {
          throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_START_FAILED");
        }
        var stdout = Task.Run(() => ReadBounded(process.StandardOutput.BaseStream, maximumOutputBytes, process));
        var stderr = Task.Run(() => ReadBounded(process.StandardError.BaseStream, maximumErrorBytes, process));
        if (!process.WaitForExit(timeoutMilliseconds)) {
          try { process.Kill(true); } catch { }
          if (!process.WaitForExit(5000)) {
            throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_TERMINATION_FAILED");
          }
          try { Task.WaitAll(new Task[] { stdout, stderr }, 5000); } catch { }
          if (!stdout.IsCompleted || !stderr.IsCompleted) {
            throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_TERMINATION_FAILED");
          }
          throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_TIMEOUT");
        }
        try {
          if (!Task.WaitAll(new Task[] { stdout, stderr }, 5000)) {
            throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_TERMINATION_FAILED");
          }
        } catch (AggregateException error) {
          if (IsOutputLimit(error)) {
            if (!process.HasExited) {
              try { process.Kill(true); } catch { }
              if (!process.WaitForExit(5000)) {
                throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_TERMINATION_FAILED");
              }
            }
            throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID");
          }
          throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID");
        }
        try {
          var utf8 = new UTF8Encoding(false, true);
          return new BoundedProcessResult {
            ExitCode = process.ExitCode,
            StandardOutput = utf8.GetString(stdout.Result),
            StandardError = utf8.GetString(stderr.Result)
          };
        } catch (DecoderFallbackException) {
          throw new InvalidOperationException("GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID");
        }
      }

    private static bool HasStarted(Process process) {
      try { return process.Id > 0; } catch { return false; }
    }
  }
}
'@
  } catch {
    Throw-Safe 'GATE_R1_SESSION_PROCESS_RUNNER_INVALID'
  }
  if (-not ('Arcanos.GateR1.BoundedProcess' -as [type])) {
    Throw-Safe 'GATE_R1_SESSION_PROCESS_RUNNER_INVALID'
  }
}

function Invoke-FixedProjector([Security.SecureString]$SecureToken, [hashtable]$Request) {
  $arguments = Get-ProjectorArguments $Request
  Assert-ExactProjectorInvocation $arguments
  Assert-FileHash $NodePath $NodeSha256 'GATE_R1_SESSION_NODE_IDENTITY_INVALID'
  Assert-FileHash $MetadataProjector $MetadataProjectorSha256 'GATE_R1_SESSION_PROJECTOR_IDENTITY_INVALID'
  Assert-FileHash $TcpProxyProjector $TcpProxyProjectorSha256 'GATE_R1_SESSION_PROJECTOR_IDENTITY_INVALID'

  $bstr = [IntPtr]::Zero
  $plainToken = $null
  $psi = $null
  $process = $null
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainToken) -or $plainToken.Length -gt 512) {
      Throw-Safe 'GATE_R1_SESSION_TOKEN_INVALID'
    }

    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $NodePath
    $psi.WorkingDirectory = $RepositoryRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'TEMP', 'TMP')) {
      $value = [Environment]::GetEnvironmentVariable($name)
      if (-not [string]::IsNullOrWhiteSpace($value)) { $psi.Environment[$name] = $value }
    }
    $psi.Environment[$ProjectorTokenName] = $plainToken
    foreach ($argument in $arguments) { [void]$psi.ArgumentList.Add($argument) }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $psi
    try {
      try {
        if (-not $process.Start()) { Throw-Safe 'GATE_R1_SESSION_PROJECTOR_START_FAILED' }
      } catch {
        Throw-Safe 'GATE_R1_SESSION_PROJECTOR_START_FAILED'
      } finally {
        [void]$psi.Environment.Remove($ProjectorTokenName)
        $plainToken = $null
        if ($bstr -ne [IntPtr]::Zero) {
          [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
          $bstr = [IntPtr]::Zero
        }
      }
      $result = [Arcanos.GateR1.BoundedProcess]::CaptureStarted(
        $process,
        $ChildTimeoutMilliseconds,
        $MaximumChildOutputBytes,
        $MaximumChildErrorBytes
      )
    } finally {
      [void]$psi.Environment.Remove($ProjectorTokenName)
      $plainToken = $null
      if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        $bstr = [IntPtr]::Zero
      }
    }

    if ($result.ExitCode -ne 0) {
      $safeChildCode = $result.StandardError.Trim()
      if ($safeChildCode -cmatch '^GATE_R1_[A-Z0-9_]+$') { Throw-Safe $safeChildCode }
      Throw-Safe 'GATE_R1_SESSION_PROJECTOR_FAILED'
    }
    if (-not [string]::IsNullOrWhiteSpace($result.StandardError)) {
      Throw-Safe 'GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID'
    }
    try {
      $projected = $result.StandardOutput | ConvertFrom-Json -AsHashtable -Depth 20
    } catch {
      Throw-Safe 'GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID'
    }
    if ($projected -isnot [hashtable]) { Throw-Safe 'GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID' }
    return $projected
  } finally {
    if ($null -ne $psi) { [void]$psi.Environment.Remove($ProjectorTokenName) }
    $plainToken = $null
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($null -ne $process) { $process.Dispose() }
  }
}

function New-SecureSessionDirectory {
  $path = Join-Path ([IO.Path]::GetTempPath()) ('arcanos-gate-r1-projector-' + [guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($path)
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity.User,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $security -ErrorAction Stop
  } catch {
    try { [IO.Directory]::Delete($path, $false) } catch {}
    Throw-Safe 'GATE_R1_SESSION_DIRECTORY_SECURITY_FAILED'
  }
  return $path
}

function Remove-SessionDirectoryGuarded([string]$Path) {
  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $resolved = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $parent = [IO.Path]::GetDirectoryName($resolved)
  $leaf = [IO.Path]::GetFileName($resolved)
  if (
    -not [StringComparer]::OrdinalIgnoreCase.Equals($parent, $temporaryRoot) -or
    $leaf -cnotmatch '^arcanos-gate-r1-projector-[0-9a-f]{32}$'
  ) {
    Throw-Safe 'GATE_R1_SESSION_CLEANUP_REFUSED'
  }
  $item = [IO.DirectoryInfo]::new($resolved)
  if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Throw-Safe 'GATE_R1_SESSION_CLEANUP_REFUSED'
  }
  foreach ($child in $item.GetFileSystemInfos()) {
    if (
      $child -isnot [IO.FileInfo] -or
      ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $child.Name -cnotmatch '^(?:ready|error|stopped|acknowledge)\.json$|^(?:request|response)-[0-9]{4}\.json$'
    ) {
      Throw-Safe 'GATE_R1_SESSION_CLEANUP_REFUSED'
    }
  }
  foreach ($child in $item.GetFiles()) { [IO.File]::Delete($child.FullName) }
  [IO.Directory]::Delete($resolved, $false)
}

function Wait-ForAcknowledgement([string]$SessionDirectory, [int]$Sequence) {
  $path = Join-Path $SessionDirectory 'acknowledge.json'
  $deadline = [DateTime]::UtcNow.AddSeconds($AcknowledgementTimeoutSeconds)
  while (-not [IO.File]::Exists($path)) {
    if ([DateTime]::UtcNow -ge $deadline) { Throw-Safe 'GATE_R1_SESSION_ACKNOWLEDGEMENT_TIMEOUT' }
    Start-Sleep -Milliseconds 250
  }
  $acknowledgement = Read-BoundedJsonFile $path $MaximumRequestBytes 'GATE_R1_SESSION_ACKNOWLEDGEMENT_INVALID'
  Assert-ExactKeys $acknowledgement @('consumedThroughSequence', 'protocolVersion', 'sequence', 'status')
  if (
    $acknowledgement.protocolVersion -isnot [long] -or
    $acknowledgement.protocolVersion -ne $ProtocolVersion -or
    $acknowledgement.sequence -isnot [long] -or
    $acknowledgement.sequence -ne $Sequence -or
    $acknowledgement.consumedThroughSequence -isnot [long] -or
    $acknowledgement.consumedThroughSequence -ne $Sequence -or
    $acknowledgement.status -cne 'consumed'
  ) {
    Throw-Safe 'GATE_R1_SESSION_ACKNOWLEDGEMENT_INVALID'
  }
}

function Invoke-GateR1ProjectorSessionMain {
  $secureToken = $null
  $sessionDirectory = $null
  $stopReason = 'GATE_R1_SESSION_LIMIT_REACHED'
  $exitCode = 1
  $acknowledged = $false
  try {
    if (Test-Path "Env:$ProjectorTokenName") {
      Throw-Safe 'GATE_R1_SESSION_AMBIENT_TOKEN_FORBIDDEN'
    }
    foreach ($ambientName in @('RAILWAY_TOKEN', 'RAILWAY_API_TOKEN', 'RAILWAY_PROJECT_TOKEN')) {
      if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($ambientName))) {
        Throw-Safe 'GATE_R1_SESSION_AMBIENT_TOKEN_FORBIDDEN'
      }
    }
    Assert-FileHash $NodePath $NodeSha256 'GATE_R1_SESSION_NODE_IDENTITY_INVALID'
    Assert-FileHash $MetadataProjector $MetadataProjectorSha256 'GATE_R1_SESSION_PROJECTOR_IDENTITY_INVALID'
    Assert-FileHash $TcpProxyProjector $TcpProxyProjectorSha256 'GATE_R1_SESSION_PROJECTOR_IDENTITY_INVALID'
    if (-not $IsWindows -or $PSVersionTable.PSEdition -cne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
      Throw-Safe 'GATE_R1_SESSION_RUNTIME_UNSUPPORTED'
    }
    Initialize-BoundedProcessType

    $secureToken = Read-Host 'Temporary Railway project token' -AsSecureString
    if ($null -eq $secureToken -or $secureToken.Length -eq 0) { Throw-Safe 'GATE_R1_SESSION_TOKEN_INVALID' }

    $sessionDirectory = New-SecureSessionDirectory
    Write-SafeJsonFile (Join-Path $sessionDirectory 'ready.json') @{
      protocolVersion = $ProtocolVersion
      status = 'ready'
      projectId = $ProjectId
      environmentId = $EnvironmentId
      maximumRequests = $MaximumRequests
      createdAt = [DateTime]::UtcNow.ToString('o')
    }
    [Console]::Out.WriteLine((@{
      protocolVersion = $ProtocolVersion
      status = 'GATE_R1_PROJECTOR_SESSION_READY'
      sessionDirectory = $sessionDirectory
    } | ConvertTo-Json -Compress))

    for ($sequence = 1; $sequence -le $MaximumRequests; $sequence += 1) {
      $requestPath = Join-Path $sessionDirectory ('request-{0:D4}.json' -f $sequence)
      $deadline = [DateTime]::UtcNow.AddSeconds($RequestTimeoutSeconds)
      while (-not [IO.File]::Exists($requestPath)) {
        if ([DateTime]::UtcNow -ge $deadline) { Throw-Safe 'GATE_R1_SESSION_REQUEST_TIMEOUT' }
        Start-Sleep -Milliseconds 250
      }
      $request = Read-BoundedJsonFile $requestPath $MaximumRequestBytes 'GATE_R1_SESSION_REQUEST_INVALID'
      if (
        -not $request.ContainsKey('protocolVersion') -or
        -not $request.ContainsKey('sequence') -or
        -not $request.ContainsKey('operation') -or
        $request.protocolVersion -isnot [long] -or
        $request.protocolVersion -ne $ProtocolVersion -or
        $request.sequence -isnot [long] -or
        $request.sequence -ne $sequence -or
        $request.operation -isnot [string]
      ) {
        Throw-Safe 'GATE_R1_SESSION_REQUEST_INVALID'
      }

      $responsePath = Join-Path $sessionDirectory ('response-{0:D4}.json' -f $sequence)
      if ($request.operation -ceq 'stop') {
        Assert-ExactKeys $request @('operation', 'protocolVersion', 'sequence')
        Write-SafeJsonFile $responsePath @{
          protocolVersion = $ProtocolVersion
          sequence = $sequence
          status = 'stopped'
        }
        Wait-ForAcknowledgement $sessionDirectory $sequence
        $acknowledged = $true
        $stopReason = 'GATE_R1_SESSION_STOPPED'
        $exitCode = 0
        break
      }

      $result = Invoke-FixedProjector $secureToken $request
      Write-SafeJsonFile $responsePath @{
        protocolVersion = $ProtocolVersion
        sequence = $sequence
        status = 'ok'
        result = $result
      }
    }
    if (-not $acknowledged) { Throw-Safe 'GATE_R1_SESSION_LIMIT_REACHED' }
  } catch {
    $stopReason = Resolve-SafeErrorCode $_
    $exitCode = 1
    if ($null -ne $sessionDirectory -and [IO.Directory]::Exists($sessionDirectory)) {
      Try-WriteSafeJsonFile (Join-Path $sessionDirectory 'error.json') @{
        protocolVersion = $ProtocolVersion
        status = 'error'
        code = $stopReason
        observedAt = [DateTime]::UtcNow.ToString('o')
      }
    }
    try { [Console]::Error.WriteLine($stopReason) } catch {}
  } finally {
    if ($null -ne $secureToken) { $secureToken.Dispose() }
    if ($null -ne $sessionDirectory -and [IO.Directory]::Exists($sessionDirectory)) {
      if ($acknowledged -and $exitCode -eq 0) {
        try {
          Remove-SessionDirectoryGuarded $sessionDirectory
        } catch {
          $exitCode = 1
          $stopReason = Resolve-SafeErrorCode $_
          Try-WriteSafeJsonFile (Join-Path $sessionDirectory 'error.json') @{
            protocolVersion = $ProtocolVersion
            status = 'error'
            code = $stopReason
            observedAt = [DateTime]::UtcNow.ToString('o')
          }
          try { [Console]::Error.WriteLine($stopReason) } catch {}
        }
      } else {
        Try-WriteSafeJsonFile (Join-Path $sessionDirectory 'stopped.json') @{
          protocolVersion = $ProtocolVersion
          status = 'stopped'
          reason = $stopReason
          observedAt = [DateTime]::UtcNow.ToString('o')
        }
      }
    }
  }
  return $exitCode
}

exit (Invoke-GateR1ProjectorSessionMain)

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectorTokenName = 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN'
$ProjectId = '7faf44e5-519c-4e73-8d7a-da9f389e6187'
$EnvironmentId = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13'
$ProtocolVersion = 1
$MaximumRequests = 14
$RequestTimeoutSeconds = 2700
$AcknowledgementTimeoutSeconds = 300
$ChildTimeoutMilliseconds = 20000
$MaximumChildOutputBytes = 262144
$MaximumChildErrorBytes = 256
$MaximumRequestBytes = 4096

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$ValidatorReferenceProjector = Join-Path $PSScriptRoot 'gate-r2-validator-reference-projector.js'
$RetirementStateProjector = Join-Path $PSScriptRoot 'gate-r2-retirement-state-projector.js'
$ValidatorReferenceProjectorSha256 = '6258CB539D97581696B5DE1710000C1B2DA252888FCBDEEFE24C6BE552F9E797'
$RetirementStateProjectorSha256 = '1C022AFBAF7ABBC1B7941A205578A1F14DCF3DB88C35078BBDA7A07E1200CD50'
$NodePath = 'C:\Program Files\nodejs\node.exe'
$NodeSha256 = 'D14BA95CDCE1EF7DC9AD3AC74949CA5DB38B27378EE30F30A23CF26F9E875A11'

$ValidatorProfiles = @{
  migration = @{
    projectorProfile = 'migration-validator'
    serviceId = 'd8d5181a-2f72-48d7-8413-6f05d113876c'
    serviceName = 'phase2e-migration-validator-20260718'
    serviceInstanceId = '7a645cbc-dadf-4072-84c1-6f0843fa30d9'
  }
  compatibility = @{
    projectorProfile = 'compatibility-validator'
    serviceId = 'febdf999-1c96-48df-8e28-c905b8b27082'
    serviceName = 'phase2e-compatibility-validator-20260718'
    serviceInstanceId = '3c385dd2-c786-4149-9319-2a168a920aa9'
  }
}

function Throw-Safe([string]$Code) {
  throw [InvalidOperationException]::new($Code)
}

function Assert-ExactKeys([hashtable]$Value, [string[]]$Expected) {
  $actual = @($Value.Keys | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID' }
  for ($index = 0; $index -lt $actual.Count; $index += 1) {
    if ($actual[$index] -cne $wanted[$index]) { Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID' }
  }
}

function Assert-ExactResultKeys([hashtable]$Value, [string[]]$Expected) {
  $actual = @($Value.Keys | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { Throw-Safe 'GATE_R2_SESSION_PROJECTOR_RESULT_INVALID' }
  for ($index = 0; $index -lt $actual.Count; $index += 1) {
    if ($actual[$index] -cne $wanted[$index]) {
      Throw-Safe 'GATE_R2_SESSION_PROJECTOR_RESULT_INVALID'
    }
  }
}

function Write-SafeJsonFile([string]$Path, [hashtable]$Value) {
  $json = $Value | ConvertTo-Json -Compress -Depth 12
  $directory = [IO.Path]::GetDirectoryName($Path)
  $temporaryPath = Join-Path $directory ('.gate-r2-write-' + [guid]::NewGuid().ToString('N') + '.tmp')
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
    if ($exception.Message -cmatch '^GATE_R2_[A-Z0-9_]+$') { return $exception.Message }
    $exception = $exception.InnerException
  }
  return 'GATE_R2_SESSION_FAILED'
}

function Get-FileSha256([string]$Path, [string]$FailureCode) {
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
  return $actual
}

function Assert-FileHash([string]$Path, [string]$ExpectedHash, [string]$FailureCode) {
  $actual = Get-FileSha256 $Path $FailureCode
  if ($actual -cne $ExpectedHash) { Throw-Safe $FailureCode }
}

function Get-LedgerStep([long]$Sequence) {
  switch ($Sequence) {
    1 { return @{ operation = 'validatorReference'; profile = 'migration' } }
    2 { return @{ operation = 'validatorReference'; profile = 'compatibility' } }
    3 { return @{ operation = 'validatorReference'; profile = 'migration' } }
    4 { return @{ operation = 'validatorReference'; profile = 'compatibility' } }
    5 { return @{ operation = 'validatorReference'; profile = 'migration' } }
    6 { return @{ operation = 'validatorReference'; profile = 'compatibility' } }
    7 { return @{ operation = 'retirementState'; phase = 'pre' } }
    8 { return @{ operation = 'retirementState'; phase = 'post'; profile = 'original-postgres' } }
    9 { return @{ operation = 'retirementState'; phase = 'post'; profile = 'failed-postgres-r2' } }
    10 { return @{ operation = 'retirementState'; phase = 'post'; profile = 'original-redis' } }
    11 { return @{ operation = 'retirementState'; phase = 'final'; profile = 'original-postgres' } }
    12 { return @{ operation = 'retirementState'; phase = 'final'; profile = 'failed-postgres-r2' } }
    13 { return @{ operation = 'retirementState'; phase = 'final'; profile = 'original-redis' } }
    14 { return @{ operation = 'stop' } }
    default { Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID' }
  }
}

function Get-ProjectorArguments([hashtable]$Request) {
  if (
    -not $Request.ContainsKey('protocolVersion') -or
    -not $Request.ContainsKey('sequence') -or
    $Request.protocolVersion -isnot [long] -or
    $Request.protocolVersion -ne $ProtocolVersion -or
    $Request.sequence -isnot [long]
  ) {
    Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID'
  }
  $expected = Get-LedgerStep $Request.sequence
  if (
    $expected.operation -ceq 'stop' -or
    -not $Request.ContainsKey('operation') -or
    $Request.operation -cne $expected.operation
  ) {
    Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID'
  }

  if ($expected.operation -ceq 'validatorReference') {
    Assert-ExactKeys $Request @('operation', 'profile', 'protocolVersion', 'sequence')
    if ($Request.profile -cne $expected.profile) { Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID' }
    return @(
      $ValidatorReferenceProjector,
      '--profile',
      [string]$ValidatorProfiles[$expected.profile].projectorProfile
    )
  }

  if ($expected.phase -ceq 'pre') {
    Assert-ExactKeys $Request @('operation', 'phase', 'protocolVersion', 'sequence')
    if ($Request.phase -cne 'pre') { Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID' }
    return @($RetirementStateProjector, '--phase', 'pre')
  }

  Assert-ExactKeys $Request @('operation', 'phase', 'profile', 'protocolVersion', 'sequence')
  if ($Request.phase -cne $expected.phase -or $Request.profile -cne $expected.profile) {
    Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID'
  }
  return @(
    $RetirementStateProjector,
    '--phase', [string]$expected.phase,
    '--profile', [string]$expected.profile
  )
}

function Assert-ExactProjectorInvocation([string[]]$Arguments) {
  if (
    $Arguments.Count -eq 3 -and
    $Arguments[0] -ceq $ValidatorReferenceProjector -and
    $Arguments[1] -ceq '--profile' -and
    ($Arguments[2] -ceq 'migration-validator' -or $Arguments[2] -ceq 'compatibility-validator')
  ) {
    return
  }
  if (
    $Arguments.Count -eq 3 -and
    $Arguments[0] -ceq $RetirementStateProjector -and
    $Arguments[1] -ceq '--phase' -and
    $Arguments[2] -ceq 'pre'
  ) {
    return
  }
  if (
    $Arguments.Count -eq 5 -and
    $Arguments[0] -ceq $RetirementStateProjector -and
    $Arguments[1] -ceq '--phase' -and
    ($Arguments[2] -ceq 'post' -or $Arguments[2] -ceq 'final') -and
    $Arguments[3] -ceq '--profile' -and
    (
      $Arguments[4] -ceq 'original-postgres' -or
      $Arguments[4] -ceq 'original-redis' -or
      $Arguments[4] -ceq 'failed-postgres-r2'
    )
  ) {
    return
  }
  Throw-Safe 'GATE_R2_SESSION_PROJECTOR_ARGUMENTS_INVALID'
}

function Assert-ObservedAt([object]$Value) {
  if ($Value -isnot [DateTime] -or $Value.Kind -ne [DateTimeKind]::Utc) {
    Throw-Safe 'GATE_R2_SESSION_PROJECTOR_RESULT_INVALID'
  }
}

function Assert-ProjectorResult([hashtable]$Request, [hashtable]$Result) {
  $expected = Get-LedgerStep $Request.sequence
  if ($expected.operation -ceq 'validatorReference') {
    Assert-ExactResultKeys $Result @(
      'activeDeploymentCount', 'environmentId', 'observedAt', 'projectId',
      'referenceCategory', 'serviceId', 'serviceInstanceId', 'serviceName',
      'validatorProfile', 'variableCount'
    )
    $profile = $ValidatorProfiles[$expected.profile]
    $baselineCategories = @('ORIGINAL_POSTGRES', 'FAILED_POSTGRES_R2', 'POSTGRES_R3')
    $categoryValid = if ($Request.sequence -le 2) {
      $baselineCategories -ccontains $Result.referenceCategory
    } else {
      $Result.referenceCategory -ceq 'POSTGRES_R3'
    }
    if (
      $Result.projectId -cne $ProjectId -or
      $Result.environmentId -cne $EnvironmentId -or
      $Result.validatorProfile -cne $profile.projectorProfile -or
      $Result.serviceId -cne $profile.serviceId -or
      $Result.serviceName -cne $profile.serviceName -or
      $Result.serviceInstanceId -cne $profile.serviceInstanceId -or
      $Result.activeDeploymentCount -isnot [long] -or
      $Result.activeDeploymentCount -ne 0 -or
      $Result.variableCount -isnot [long] -or
      $Result.variableCount -ne 1 -or
      -not $categoryValid
    ) {
      Throw-Safe 'GATE_R2_SESSION_PROJECTOR_RESULT_INVALID'
    }
    Assert-ObservedAt $Result.observedAt
    return
  }

  Assert-ExactResultKeys $Result @(
    'consumers', 'disposedProfile', 'environmentId', 'observedAt', 'phase',
    'privateNetworkId', 'projectId', 'reasonCodes', 'replacements',
    'retiredProfile', 'schemaVersion', 'sharedVariableCount', 'status', 'targets'
  )
  $expectedRetiredProfile = if ($expected.phase -ceq 'post') { $expected.profile } else { $null }
  $expectedDisposedProfile = if ($expected.phase -ceq 'final') { $expected.profile } else { $null }
  if (
    $Result.schemaVersion -isnot [long] -or
    $Result.schemaVersion -ne 2 -or
    $Result.projectId -cne $ProjectId -or
    $Result.environmentId -cne $EnvironmentId -or
    $Result.privateNetworkId -cne '464f2194-3825-4ac1-a705-192566561675' -or
    $Result.phase -cne $expected.phase -or
    $Result.retiredProfile -cne $expectedRetiredProfile -or
    $Result.disposedProfile -cne $expectedDisposedProfile -or
    $Result.status -cne 'PASS' -or
    @($Result.reasonCodes).Count -ne 0 -or
    $Result.sharedVariableCount -isnot [long] -or
    $Result.sharedVariableCount -ne 0 -or
    @($Result.targets).Count -ne 3 -or
    @($Result.replacements).Count -ne 2 -or
    @($Result.consumers).Count -ne 4
  ) {
    Throw-Safe 'GATE_R2_SESSION_PROJECTOR_RESULT_INVALID'
  }
  Assert-ObservedAt $Result.observedAt
}

function Initialize-BoundedProcessType {
  if ('Arcanos.GateR2.BoundedProcess' -as [type]) { return }
  try {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace Arcanos.GateR2 {
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
          throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_START_FAILED");
        }
        var stdout = Task.Run(() => ReadBounded(process.StandardOutput.BaseStream, maximumOutputBytes, process));
        var stderr = Task.Run(() => ReadBounded(process.StandardError.BaseStream, maximumErrorBytes, process));
        if (!process.WaitForExit(timeoutMilliseconds)) {
          try { process.Kill(true); } catch { }
          if (!process.WaitForExit(5000)) {
            throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_TERMINATION_FAILED");
          }
          try { Task.WaitAll(new Task[] { stdout, stderr }, 5000); } catch { }
          if (!stdout.IsCompleted || !stderr.IsCompleted) {
            throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_TERMINATION_FAILED");
          }
          throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_TIMEOUT");
        }
        try {
          if (!Task.WaitAll(new Task[] { stdout, stderr }, 5000)) {
            throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_TERMINATION_FAILED");
          }
        } catch (AggregateException error) {
          if (IsOutputLimit(error)) {
            if (!process.HasExited) {
              try { process.Kill(true); } catch { }
              if (!process.WaitForExit(5000)) {
                throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_TERMINATION_FAILED");
              }
            }
            throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID");
          }
          throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID");
        }
        try {
          var utf8 = new UTF8Encoding(false, true);
          return new BoundedProcessResult {
            ExitCode = process.ExitCode,
            StandardOutput = utf8.GetString(stdout.Result),
            StandardError = utf8.GetString(stderr.Result)
          };
        } catch (DecoderFallbackException) {
          throw new InvalidOperationException("GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID");
        }
      }

    private static bool HasStarted(Process process) {
      try { return process.Id > 0; } catch { return false; }
    }
  }
}
'@
  } catch {
    Throw-Safe 'GATE_R2_SESSION_PROCESS_RUNNER_INVALID'
  }
  if (-not ('Arcanos.GateR2.BoundedProcess' -as [type])) {
    Throw-Safe 'GATE_R2_SESSION_PROCESS_RUNNER_INVALID'
  }
}

function Invoke-FixedProjector([Security.SecureString]$SecureToken, [hashtable]$Request) {
  $arguments = Get-ProjectorArguments $Request
  Assert-ExactProjectorInvocation $arguments
  Assert-FileHash $NodePath $NodeSha256 'GATE_R2_SESSION_NODE_IDENTITY_INVALID'
  Assert-FileHash $ValidatorReferenceProjector $ValidatorReferenceProjectorSha256 'GATE_R2_SESSION_PROJECTOR_IDENTITY_INVALID'
  Assert-FileHash $RetirementStateProjector $RetirementStateProjectorSha256 'GATE_R2_SESSION_PROJECTOR_IDENTITY_INVALID'

  $bstr = [IntPtr]::Zero
  $plainToken = $null
  $psi = $null
  $process = $null
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainToken) -or $plainToken.Length -gt 512) {
      Throw-Safe 'GATE_R2_SESSION_TOKEN_INVALID'
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
        if (-not $process.Start()) { Throw-Safe 'GATE_R2_SESSION_PROJECTOR_START_FAILED' }
      } catch {
        Throw-Safe 'GATE_R2_SESSION_PROJECTOR_START_FAILED'
      } finally {
        [void]$psi.Environment.Remove($ProjectorTokenName)
        $plainToken = $null
        if ($bstr -ne [IntPtr]::Zero) {
          [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
          $bstr = [IntPtr]::Zero
        }
      }
      $result = [Arcanos.GateR2.BoundedProcess]::CaptureStarted(
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
      if ($safeChildCode -cmatch '^GATE_R2_[A-Z0-9_]+$') { Throw-Safe $safeChildCode }
      Throw-Safe 'GATE_R2_SESSION_PROJECTOR_FAILED'
    }
    if (-not [string]::IsNullOrWhiteSpace($result.StandardError)) {
      Throw-Safe 'GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID'
    }
    try {
      $projected = $result.StandardOutput | ConvertFrom-Json -AsHashtable -Depth 20
    } catch {
      Throw-Safe 'GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID'
    }
    if ($projected -isnot [hashtable]) { Throw-Safe 'GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID' }
    return $projected
  } finally {
    if ($null -ne $psi) { [void]$psi.Environment.Remove($ProjectorTokenName) }
    $plainToken = $null
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($null -ne $process) { $process.Dispose() }
  }
}

function New-SecureSessionDirectory {
  $path = Join-Path ([IO.Path]::GetTempPath()) ('arcanos-gate-r2-projector-' + [guid]::NewGuid().ToString('N'))
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
    Throw-Safe 'GATE_R2_SESSION_DIRECTORY_SECURITY_FAILED'
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
    $leaf -cnotmatch '^arcanos-gate-r2-projector-[0-9a-f]{32}$'
  ) {
    Throw-Safe 'GATE_R2_SESSION_CLEANUP_REFUSED'
  }
  $item = [IO.DirectoryInfo]::new($resolved)
  if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Throw-Safe 'GATE_R2_SESSION_CLEANUP_REFUSED'
  }
  foreach ($child in $item.GetFileSystemInfos()) {
    if (
      $child -isnot [IO.FileInfo] -or
      ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $child.Name -cnotmatch '^(?:ready|error|stopped|acknowledge)\.json$|^(?:request|response)-[0-9]{4}\.json$'
    ) {
      Throw-Safe 'GATE_R2_SESSION_CLEANUP_REFUSED'
    }
  }
  foreach ($child in $item.GetFiles()) { [IO.File]::Delete($child.FullName) }
  [IO.Directory]::Delete($resolved, $false)
}

function Wait-ForAcknowledgement([string]$SessionDirectory, [int]$Sequence) {
  $path = Join-Path $SessionDirectory 'acknowledge.json'
  $deadline = [DateTime]::UtcNow.AddSeconds($AcknowledgementTimeoutSeconds)
  while (-not [IO.File]::Exists($path)) {
    if ([DateTime]::UtcNow -ge $deadline) { Throw-Safe 'GATE_R2_SESSION_ACKNOWLEDGEMENT_TIMEOUT' }
    Start-Sleep -Milliseconds 250
  }
  $acknowledgement = Read-BoundedJsonFile $path $MaximumRequestBytes 'GATE_R2_SESSION_ACKNOWLEDGEMENT_INVALID'
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
    Throw-Safe 'GATE_R2_SESSION_ACKNOWLEDGEMENT_INVALID'
  }
}

function Invoke-GateR2ProjectorSessionMain {
  $secureToken = $null
  $sessionDirectory = $null
  $stopReason = 'GATE_R2_SESSION_LIMIT_REACHED'
  $exitCode = 1
  $acknowledged = $false
  try {
    if (Test-Path "Env:$ProjectorTokenName") {
      Throw-Safe 'GATE_R2_SESSION_AMBIENT_TOKEN_FORBIDDEN'
    }
    foreach ($ambientName in @('RAILWAY_TOKEN', 'RAILWAY_API_TOKEN', 'RAILWAY_PROJECT_TOKEN')) {
      if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($ambientName))) {
        Throw-Safe 'GATE_R2_SESSION_AMBIENT_TOKEN_FORBIDDEN'
      }
    }
    Assert-FileHash $NodePath $NodeSha256 'GATE_R2_SESSION_NODE_IDENTITY_INVALID'
    Assert-FileHash $ValidatorReferenceProjector $ValidatorReferenceProjectorSha256 'GATE_R2_SESSION_PROJECTOR_IDENTITY_INVALID'
    Assert-FileHash $RetirementStateProjector $RetirementStateProjectorSha256 'GATE_R2_SESSION_PROJECTOR_IDENTITY_INVALID'
    $sessionScriptSha256 = Get-FileSha256 $PSCommandPath 'GATE_R2_SESSION_SCRIPT_IDENTITY_INVALID'
    try {
      $sessionProcessIdentity = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()
    } catch {
      Throw-Safe 'GATE_R2_SESSION_PROCESS_IDENTITY_INVALID'
    }
    if ($sessionProcessIdentity -cnotmatch '^[1-9][0-9]{0,19}$') {
      Throw-Safe 'GATE_R2_SESSION_PROCESS_IDENTITY_INVALID'
    }
    if (-not $IsWindows -or $PSVersionTable.PSEdition -cne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
      Throw-Safe 'GATE_R2_SESSION_RUNTIME_UNSUPPORTED'
    }
    Initialize-BoundedProcessType

    $secureToken = Read-Host 'Temporary Railway project token' -AsSecureString
    if ($null -eq $secureToken -or $secureToken.Length -eq 0) { Throw-Safe 'GATE_R2_SESSION_TOKEN_INVALID' }

    $sessionDirectory = New-SecureSessionDirectory
    Write-SafeJsonFile (Join-Path $sessionDirectory 'ready.json') @{
      protocolVersion = $ProtocolVersion
      status = 'ready'
      projectId = $ProjectId
      environmentId = $EnvironmentId
      maximumRequests = $MaximumRequests
      createdAt = [DateTime]::UtcNow.ToString('o')
      sessionProcessId = $PID
      sessionProcessIdentity = $sessionProcessIdentity
      sessionScriptSha256 = $sessionScriptSha256
    }
    [Console]::Out.WriteLine((@{
      protocolVersion = $ProtocolVersion
      status = 'GATE_R2_PROJECTOR_SESSION_READY'
      sessionDirectory = $sessionDirectory
      sessionProcessId = $PID
      sessionProcessIdentity = $sessionProcessIdentity
      sessionScriptSha256 = $sessionScriptSha256
    } | ConvertTo-Json -Compress))

    for ($sequence = 1; $sequence -le $MaximumRequests; $sequence += 1) {
      $requestPath = Join-Path $sessionDirectory ('request-{0:D4}.json' -f $sequence)
      $deadline = [DateTime]::UtcNow.AddSeconds($RequestTimeoutSeconds)
      while (-not [IO.File]::Exists($requestPath)) {
        if ([DateTime]::UtcNow -ge $deadline) { Throw-Safe 'GATE_R2_SESSION_REQUEST_TIMEOUT' }
        Start-Sleep -Milliseconds 250
      }
      $request = Read-BoundedJsonFile $requestPath $MaximumRequestBytes 'GATE_R2_SESSION_REQUEST_INVALID'
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
        Throw-Safe 'GATE_R2_SESSION_REQUEST_INVALID'
      }

      $responsePath = Join-Path $sessionDirectory ('response-{0:D4}.json' -f $sequence)
      if ($request.operation -ceq 'stop') {
        Assert-ExactKeys $request @('operation', 'protocolVersion', 'sequence')
        $completedLedger = $sequence -eq $MaximumRequests
        Write-SafeJsonFile $responsePath @{
          protocolVersion = $ProtocolVersion
          sequence = $sequence
          status = 'stopped'
          completedLedger = $completedLedger
        }
        Wait-ForAcknowledgement $sessionDirectory $sequence
        $acknowledged = $true
        $stopReason = 'GATE_R2_SESSION_STOPPED'
        $exitCode = 0
        break
      }

      $result = Invoke-FixedProjector $secureToken $request
      Assert-ProjectorResult $request $result
      Write-SafeJsonFile $responsePath @{
        protocolVersion = $ProtocolVersion
        sequence = $sequence
        status = 'ok'
        result = $result
      }
    }
    if (-not $acknowledged) { Throw-Safe 'GATE_R2_SESSION_LIMIT_REACHED' }
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

exit (Invoke-GateR2ProjectorSessionMain)

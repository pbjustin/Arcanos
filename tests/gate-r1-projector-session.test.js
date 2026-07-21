import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sessionScriptUrl = new URL(
  '../scripts/gate-r1-projector-session-20260719.ps1',
  import.meta.url
);
const sessionScript = readFileSync(sessionScriptUrl, 'utf8');
const sessionScriptPath = decodeURIComponent(sessionScriptUrl.pathname).replace(/^\/(?:([A-Za-z]:))/, '$1');
const cleanupDirectories = new Set();
const windowsIt = process.platform === 'win32' ? it : it.skip;

function createHarness({ copyProjectors = false } = {}) {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'gate-r1-session-harness-'));
  cleanupDirectories.add(harnessRoot);
  const harnessScripts = join(harnessRoot, 'scripts');
  mkdirSync(harnessScripts);
  const harnessScript = join(harnessScripts, 'gate-r1-projector-session-20260719.ps1');
  const harnessSource = sessionScript.replace(/\r?\nexit \(Invoke-GateR1ProjectorSessionMain\)\s*$/, '\n');
  writeFileSync(harnessScript, harnessSource, 'utf8');
  if (copyProjectors) {
    for (const name of [
      'gate-r1-railway-metadata-projector.js',
      'gate-r1-tcp-proxy-projector.js'
    ]) {
      copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(harnessScripts, name));
    }
  }
  return harnessScript;
}

function runBoundedFixture(mode, timeoutMs = 5_000) {
  const harnessScript = createHarness();
  const fixturePath = decodeURIComponent(
    new URL('./fixtures/gate-r1-bounded-process-fixture.mjs', import.meta.url).pathname
  ).replace(/^\/(?:([A-Za-z]:))/, '$1');
  const escapedHarness = harnessScript.replaceAll("'", "''");
  const escapedFixture = fixturePath.replaceAll("'", "''");
  const escapedNodePath = process.execPath.replaceAll("'", "''");
  const command = [
    `. '${escapedHarness}'`,
    'Initialize-BoundedProcessType',
    "$psi=[Diagnostics.ProcessStartInfo]::new()",
    `$psi.FileName='${escapedNodePath}'`,
    '$psi.UseShellExecute=$false',
    '$psi.RedirectStandardOutput=$true',
    '$psi.RedirectStandardError=$true',
    '$psi.CreateNoWindow=$true',
    `[void]$psi.ArgumentList.Add('${escapedFixture}')`,
    `[void]$psi.ArgumentList.Add('${mode}')`,
    '$process=[Diagnostics.Process]::new()',
    '$process.StartInfo=$psi',
    'try { [void]$process.Start(); try { $result=[Arcanos.GateR1.BoundedProcess]::CaptureStarted($process,'
      + `${timeoutMs},2048,256); @{exitCode=$result.ExitCode;stdout=$result.StandardOutput;stderr=$result.StandardError}`
      + " | ConvertTo-Json -Compress } catch { [Console]::Out.WriteLine((Resolve-SafeErrorCode $_)) } } finally { if(-not $process.HasExited){try{$process.Kill($true);[void]$process.WaitForExit(5000)}catch{}};$process.Dispose() }"
  ].join('; ');
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], {
    encoding: 'utf8',
    env: withoutRailwayTokens(),
    timeout: 15_000,
    windowsHide: true
  });
}

function runProjectorArgumentRequest(request) {
  const harnessScript = createHarness();
  const escapedHarness = harnessScript.replaceAll("'", "''");
  const requestJson = JSON.stringify(request).replaceAll("'", "''");
  const command = [
    `. '${escapedHarness}'`,
    `$request='${requestJson}' | ConvertFrom-Json -AsHashtable`,
    "try { $projectorArguments=@(Get-ProjectorArguments $request); @{ok=$true;arguments=$projectorArguments} | ConvertTo-Json -Compress } catch { @{ok=$false;code=(Resolve-SafeErrorCode $_)} | ConvertTo-Json -Compress }"
  ].join('; ');
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], {
    encoding: 'utf8',
    env: withoutRailwayTokens(),
    timeout: 15_000,
    windowsHide: true
  });
}

function withoutRailwayTokens() {
  const env = { ...process.env };
  for (const name of [
    'ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN',
    'RAILWAY_TOKEN',
    'RAILWAY_API_TOKEN',
    'RAILWAY_PROJECT_TOKEN'
  ]) {
    delete env[name];
  }
  return env;
}

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
}

async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('fixture-timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  for (const path of cleanupDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

describe('Gate R1 projector session', () => {
  it('parses as PowerShell without executing', () => {
    const escaped = sessionScriptPath.replaceAll("'", "''");
    const output = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$errors); if($errors.Count){exit 1}; 'PARSE_OK'`
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    expect(output.status).toBe(0);
    expect(output.stdout.trim()).toBe('PARSE_OK');
    expect(output.stderr).toBe('');
  });

  it('prompts once and never places the token in the parent environment or arguments', () => {
    expect(sessionScript.match(/Read-Host 'Temporary Railway project token' -AsSecureString/g)).toHaveLength(1);
    expect(sessionScript).toContain('SecureStringToBSTR');
    expect(sessionScript).toContain('PtrToStringBSTR');
    expect(sessionScript).toContain('ZeroFreeBSTR');
    expect(sessionScript).toContain('$psi.Environment.Clear()');
    expect(sessionScript).toContain('$psi.Environment[$ProjectorTokenName] = $plainToken');
    expect(sessionScript).toContain('[void]$psi.Environment.Remove($ProjectorTokenName)');
    expect(sessionScript).toContain('[void]$psi.Environment.Remove($ProjectorTokenName)');
    expect(sessionScript).not.toMatch(/\$env:ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN\s*=/i);
    expect(sessionScript).not.toContain('ConvertFrom-SecureString');
    expect(sessionScript).not.toContain('Set-Clipboard');
  });

  it('rejects an ambient projector token with one fixed diagnostic', () => {
    const result = spawnSync(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-File', sessionScriptPath],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...withoutRailwayTokens(),
          ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN: 'test-only-placeholder'
        }
      }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('GATE_R1_SESSION_AMBIENT_TOKEN_FORBIDDEN');
    expect(`${result.stdout}${result.stderr}`).not.toContain('test-only-placeholder');
  });

  it('has no reusable arbitrary child-launch seam', () => {
    expect(sessionScript).toContain('function Invoke-FixedProjector([Security.SecureString]$SecureToken, [hashtable]$Request)');
    expect(sessionScript).toContain('Assert-ExactProjectorInvocation $arguments');
    expect(sessionScript).toContain("$NodePath = 'C:\\Program Files\\nodejs\\node.exe'");
    expect(sessionScript).toContain('exit (Invoke-GateR1ProjectorSessionMain)');
    expect(sessionScript).not.toContain('$NodePath = $null');
    expect(sessionScript).not.toContain('$MyInvocation.InvocationName');
    expect(sessionScript).not.toMatch(/function Invoke-FixedProjector\([^)]*\[string\[\]\]\$Arguments/);
    expect(sessionScript).not.toMatch(/\$psi\.FileName\s*=.*railway/i);
    expect(sessionScript).not.toMatch(/Get-Command\s+railway/i);
    expect(sessionScript).not.toContain('Invoke-Expression');
    expect(sessionScript).not.toContain('Start-Process');
    expect(sessionScript).not.toMatch(/\bcmd(?:\.exe)?\b/i);
    expect(sessionScript).not.toMatch(/pwsh\s+-Command/i);
  });

  it('pins every executable artifact before each projector launch', () => {
    for (const value of [
      '8771C9DD822E496518DAC67048214BE1D0E4330A7C6A917B56DB771E6892FE59',
      'E6B1EB138DA5734ECF429378E86C04F64936020ECAE4B4E9CD58F2E5703A256E',
      'D14BA95CDCE1EF7DC9AD3AC74949CA5DB38B27378EE30F30A23CF26F9E875A11'
    ]) {
      expect(sessionScript).toContain(value);
    }
    const invokeBody = sessionScript.slice(
      sessionScript.indexOf('function Invoke-FixedProjector'),
      sessionScript.indexOf('function New-SecureSessionDirectory')
    );
    expect(invokeBody.match(/Assert-FileHash/g)).toHaveLength(3);
    expect(invokeBody.indexOf('Assert-FileHash')).toBeLessThan(invokeBody.indexOf('SecureStringToBSTR'));
  });

  it('uses a case-sensitive, versioned, exact operation protocol', () => {
    expect(sessionScript).toContain('switch -CaseSensitive ($Request.operation)');
    expect(sessionScript).toContain("'protocolVersion'");
    expect(sessionScript).toContain("$PrivateNetworkId = '464f2194-3825-4ac1-a705-192566561675'");
    for (const operation of ['environment', 'fixedProxy', 'replacementProxy', 'endpoint', 'stop']) {
      expect(sessionScript).toContain(`'${operation}'`);
    }
    expect(sessionScript).toContain('$request.operation -ceq \'stop\'');
    expect(sessionScript).toContain('postgres-r3');
  });

  it('hard-pins the approved project, environment, and current replacement services', () => {
    for (const value of [
      '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
      'b7789306-8aef-4113-add5-02883a6cc087',
      '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
      'a2a57da4-a928-427f-be30-d4a68b59a117',
      '1ac0bd56-50b3-49eb-954c-ea83515ec915',
      '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
      '86dde430-50ac-4d5c-95c3-cb27064eff51',
      'phase2e-postgres-r2-20260718',
      'phase2e-redis-r2-20260718',
      'phase2e-postgres-r3-20260720'
    ]) {
      expect(sessionScript).toContain(value);
    }
  });

  it('maps only the two original services through the fixed proxy protocol', () => {
    for (const serviceId of [
      'b7789306-8aef-4113-add5-02883a6cc087',
      '434fa5b4-b52c-4caf-aaba-e87c173bf10d'
    ]) {
      const result = runProjectorArgumentRequest({
        operation: 'fixedProxy', protocolVersion: 1, sequence: 1, serviceId
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const projected = JSON.parse(result.stdout);
      expect(projected.ok).toBe(true);
      expect(projected.arguments[0].replaceAll('\\', '/')).toMatch(/\/scripts\/gate-r1-tcp-proxy-projector\.js$/);
      expect(projected.arguments.slice(1)).toEqual(['--service-id', serviceId]);
    }
    const rejected = runProjectorArgumentRequest({
      operation: 'fixedProxy', protocolVersion: 1, sequence: 1,
      serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c'
    });
    expect(rejected.status).toBe(0);
    expect(rejected.stderr).toBe('');
    expect(JSON.parse(rejected.stdout)).toEqual({
      code: 'GATE_R1_SESSION_REQUEST_INVALID',
      ok: false
    });
  });

  it('maps only the exact observed R3 proxy and endpoint requests', () => {
    const serviceId = '7346b3f6-bf3d-46e1-9d66-79f10847ef89';
    const serviceInstanceId = '86dde430-50ac-4d5c-95c3-cb27064eff51';
    const privateNetworkId = '464f2194-3825-4ac1-a705-192566561675';
    const proxy = runProjectorArgumentRequest({
      operation: 'replacementProxy',
      profile: 'postgres-r3',
      protocolVersion: 1,
      sequence: 1,
      serviceId,
      serviceInstanceId
    });
    expect(proxy.status).toBe(0);
    expect(proxy.stderr).toBe('');
    const projectedProxy = JSON.parse(proxy.stdout);
    expect(projectedProxy.ok).toBe(true);
    expect(projectedProxy.arguments[0].replaceAll('\\', '/'))
      .toMatch(/\/scripts\/gate-r1-tcp-proxy-projector\.js$/);
    expect(projectedProxy.arguments.slice(1)).toEqual([
      '--replacement-profile', 'postgres-r3', '--service-id', serviceId,
      '--service-instance-id', serviceInstanceId
    ]);

    const endpoint = runProjectorArgumentRequest({
      operation: 'endpoint',
      profile: 'postgres-r3',
      protocolVersion: 1,
      sequence: 1,
      serviceId,
      privateNetworkId
    });
    expect(endpoint.status).toBe(0);
    expect(endpoint.stderr).toBe('');
    const projectedEndpoint = JSON.parse(endpoint.stdout);
    expect(projectedEndpoint.ok).toBe(true);
    expect(projectedEndpoint.arguments[0].replaceAll('\\', '/'))
      .toMatch(/\/scripts\/gate-r1-railway-metadata-projector\.js$/);
    expect(projectedEndpoint.arguments.slice(1)).toEqual([
      '--endpoint', '--service-id', serviceId,
      '--service-name', 'phase2e-postgres-r3-20260720',
      '--private-network-id', privateNetworkId
    ]);
  });

  it('rejects every unbound or malformed R3 request', () => {
    for (const request of [
      {
        operation: 'replacementProxy', profile: 'postgres-r3', protocolVersion: 1, sequence: 1,
        serviceId: '88888888-9999-4aaa-8bbb-cccccccccccc',
        serviceInstanceId: '22222222-3333-4444-8555-666666666666'
      },
      {
        operation: 'endpoint', profile: 'postgres-r3', protocolVersion: 1, sequence: 1,
        serviceId: '88888888-9999-4aaa-8bbb-cccccccccccc',
        privateNetworkId: '464f2194-3825-4ac1-a705-192566561675'
      },
      {
        operation: 'replacementProxy', profile: 'postgres-r3', protocolVersion: 1, sequence: 1,
        serviceId: '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
        serviceInstanceId: '22222222-3333-4444-8555-666666666666'
      },
      {
        operation: 'endpoint', profile: 'postgres-r3', protocolVersion: 1, sequence: 1,
        serviceId: '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
        privateNetworkId: '11111111-2222-4333-8444-555555555555'
      },
      {
        operation: 'endpoint', profile: 'postgres-r3', protocolVersion: 1, sequence: 1,
        serviceId: '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
        privateNetworkId: '464f2194-3825-4ac1-a705-192566561675',
        unexpected: true
      }
    ]) {
      const result = runProjectorArgumentRequest(request);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        code: 'GATE_R1_SESSION_REQUEST_INVALID',
        ok: false
      });
    }
  });

  it('bounds child output and confirms timeout termination', () => {
    expect(sessionScript).toContain('$MaximumRequests = 20');
    expect(sessionScript).toContain('$ChildTimeoutMilliseconds = 20000');
    expect(sessionScript).toContain('$MaximumChildOutputBytes = 262144');
    expect(sessionScript).toContain('$MaximumChildErrorBytes = 256');
    expect(sessionScript).toContain('$MaximumRequestBytes = 4096');
    expect(sessionScript).toContain('ReadBounded(Stream stream, int maximumBytes, Process process)');
    expect(sessionScript).toContain('if (read > maximumBytes - total)');
    expect(sessionScript).toContain('process.Kill(true)');
    expect(sessionScript).toContain('if (!process.WaitForExit(5000))');
    expect(sessionScript).toContain('Task.WaitAll(new Task[] { stdout, stderr }, 5000)');
    expect(sessionScript).toContain('GATE_R1_SESSION_LIMIT_REACHED');
    expect(sessionScript).not.toContain('ReadToEndAsync');
  });

  it.each([
    ['stdout-over', 'GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID'],
    ['stderr-over', 'GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID'],
    ['invalid-utf8', 'GATE_R1_SESSION_PROJECTOR_OUTPUT_INVALID'],
    ['timeout', 'GATE_R1_SESSION_PROJECTOR_TIMEOUT']
  ])('fails closed for bounded-process fixture %s', (mode, expectedCode) => {
    const result = runBoundedFixture(mode, mode === 'timeout' ? 100 : 5_000);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(expectedCode);
  });

  it('captures valid bounded output without using a token', () => {
    const result = runBoundedFixture('valid');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: '{"schemaVersion":1}\n'
    });
  });

  it('uses atomic file writes, exclusive bounded reads, and acknowledged cleanup', () => {
    expect(sessionScript).toContain('[IO.FileMode]::CreateNew');
    expect(sessionScript).toContain('[IO.File]::Move($temporaryPath, $Path, $false)');
    expect(sessionScript).toContain('[IO.FileShare]::None');
    expect(sessionScript).toContain('Wait-ForAcknowledgement $sessionDirectory $sequence');
    expect(sessionScript).toContain("$acknowledgement.status -cne 'consumed'");
    expect(sessionScript).toContain('Remove-SessionDirectoryGuarded $sessionDirectory');
    expect(sessionScript).toContain("'^arcanos-gate-r1-projector-[0-9a-f]{32}$'");
    expect(sessionScript).toContain('Try-WriteSafeJsonFile');
  });

  windowsIt('completes a no-network stop/ack session and removes its session directory', async () => {
    const harnessScript = createHarness({ copyProjectors: true });
    const escapedHarness = harnessScript.replaceAll("'", "''");
    const command = [
      "function global:Read-Host { [CmdletBinding()] param([Parameter(Position=0)][string]$Prompt,[switch]$AsSecureString) ConvertTo-SecureString 'test-only-placeholder' -AsPlainText -Force }",
      `. '${escapedHarness}'`,
      'exit (Invoke-GateR1ProjectorSessionMain)'
    ].join('; ');
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], {
      env: withoutRailwayTokens(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let sessionDirectory;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/\{[^\r\n]*"status":"GATE_R1_PROJECTOR_SESSION_READY"[^\r\n]*\}/);
      if (match && !sessionDirectory) {
        sessionDirectory = JSON.parse(match[0]).sessionDirectory;
        cleanupDirectories.add(sessionDirectory);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end();

    const readyDeadline = Date.now() + 15_000;
    while (!sessionDirectory) {
      if (Date.now() >= readyDeadline) {
        child.kill();
        throw new Error(`session-not-ready:${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const requestPath = join(sessionDirectory, 'request-0001.json');
    atomicWriteJson(requestPath, {
      operation: 'stop',
      protocolVersion: 1,
      sequence: 1
    });
    const responsePath = join(sessionDirectory, 'response-0001.json');
    await waitForFile(responsePath);
    expect(JSON.parse(readFileSync(responsePath, 'utf8'))).toEqual({
      protocolVersion: 1,
      sequence: 1,
      status: 'stopped'
    });
    atomicWriteJson(join(sessionDirectory, 'acknowledge.json'), {
      consumedThroughSequence: 1,
      protocolVersion: 1,
      sequence: 1,
      status: 'consumed'
    });

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('session-exit-timeout'));
      }, 15_000);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).not.toContain('test-only-placeholder');
    expect(existsSync(sessionDirectory)).toBe(false);
    cleanupDirectories.delete(sessionDirectory);
  }, 40_000);
});

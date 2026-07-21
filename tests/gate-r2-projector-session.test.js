import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sessionScriptUrl = new URL(
  '../scripts/gate-r2-projector-session-20260720.ps1',
  import.meta.url
);
const sessionScript = readFileSync(sessionScriptUrl, 'utf8');
const sessionScriptPath = decodeURIComponent(sessionScriptUrl.pathname)
  .replace(/^\/(?:([A-Za-z]:))/, '$1');
const cleanupDirectories = new Set();
const windowsIt = process.platform === 'win32' ? it : it.skip;

function withoutRailwayTokens() {
  const environment = { ...process.env };
  for (const name of [
    'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN',
    'RAILWAY_TOKEN',
    'RAILWAY_API_TOKEN',
    'RAILWAY_PROJECT_TOKEN'
  ]) {
    delete environment[name];
  }
  return environment;
}

function createHarness({ copyProjectors = false } = {}) {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'gate-r2-session-harness-'));
  cleanupDirectories.add(harnessRoot);
  const harnessScripts = join(harnessRoot, 'scripts');
  mkdirSync(harnessScripts);
  const harnessScript = join(harnessScripts, 'gate-r2-projector-session-20260720.ps1');
  const harnessSource = sessionScript.replace(
    /\r?\nexit \(Invoke-GateR2ProjectorSessionMain\)\s*$/,
    '\n'
  );
  writeFileSync(harnessScript, harnessSource, 'utf8');
  if (copyProjectors) {
    for (const name of [
      'gate-r2-validator-reference-projector.js',
      'gate-r2-retirement-state-projector.js'
    ]) {
      copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(harnessScripts, name));
    }
  }
  return harnessScript;
}

function runProjectorArgumentRequest(request) {
  const harnessScript = createHarness();
  const escapedHarness = harnessScript.replaceAll("'", "''");
  const requestJson = JSON.stringify(request).replaceAll("'", "''");
  const command = [
    `. '${escapedHarness}'`,
    `$request='${requestJson}' | ConvertFrom-Json -AsHashtable`,
    "try { $arguments=@(Get-ProjectorArguments $request); Assert-ExactProjectorInvocation $arguments; @{ok=$true;arguments=$arguments} | ConvertTo-Json -Compress } catch { @{ok=$false;code=(Resolve-SafeErrorCode $_)} | ConvertTo-Json -Compress }"
  ].join('; ');
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], {
    encoding: 'utf8',
    env: withoutRailwayTokens(),
    timeout: 15_000,
    windowsHide: true
  });
}

function runProjectorResultAssertion(request, result) {
  const harnessScript = createHarness();
  const escapedHarness = harnessScript.replaceAll("'", "''");
  const requestJson = JSON.stringify(request).replaceAll("'", "''");
  const resultJson = JSON.stringify(result).replaceAll("'", "''");
  const command = [
    `. '${escapedHarness}'`,
    `$request='${requestJson}' | ConvertFrom-Json -AsHashtable`,
    `$result='${resultJson}' | ConvertFrom-Json -AsHashtable`,
    "try { Assert-ProjectorResult $request $result; @{ok=$true} | ConvertTo-Json -Compress } catch { @{ok=$false;code=(Resolve-SafeErrorCode $_)} | ConvertTo-Json -Compress }"
  ].join('; ');
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], {
    encoding: 'utf8',
    env: withoutRailwayTokens(),
    timeout: 15_000,
    windowsHide: true
  });
}

const validatorIdentities = {
  migration: {
    validatorProfile: 'migration-validator',
    serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c',
    serviceName: 'phase2e-migration-validator-20260718',
    serviceInstanceId: '7a645cbc-dadf-4072-84c1-6f0843fa30d9'
  },
  compatibility: {
    validatorProfile: 'compatibility-validator',
    serviceId: 'febdf999-1c96-48df-8e28-c905b8b27082',
    serviceName: 'phase2e-compatibility-validator-20260718',
    serviceInstanceId: '3c385dd2-c786-4149-9319-2a168a920aa9'
  }
};

function validatorResult(profile, referenceCategory) {
  return {
    projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
    environmentId: 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
    ...validatorIdentities[profile],
    observedAt: '2026-07-20T12:00:00.000Z',
    activeDeploymentCount: 0,
    variableCount: 1,
    referenceCategory
  };
}

function retirementResult(phase, profile = null) {
  return {
    schemaVersion: 2,
    observedAt: '2026-07-20T12:00:00.000Z',
    projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
    environmentId: 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
    privateNetworkId: '464f2194-3825-4ac1-a705-192566561675',
    phase,
    retiredProfile: phase === 'post' ? profile : null,
    disposedProfile: phase === 'final' ? profile : null,
    status: 'PASS',
    reasonCodes: [],
    sharedVariableCount: 0,
    targets: [{}, {}, {}],
    replacements: [{}, {}],
    consumers: [{}, {}, {}, {}]
  };
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
    'try { [void]$process.Start(); try { $result=[Arcanos.GateR2.BoundedProcess]::CaptureStarted($process,'
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

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
}

async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('fixture-timeout');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  for (const path of cleanupDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

describe('Gate R2 bounded masked projector session', () => {
  it('parses as PowerShell without executing', () => {
    const escaped = sessionScriptPath.replaceAll("'", "''");
    const output = spawnSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$errors); if($errors.Count){exit 1}; 'PARSE_OK'`
    ], { encoding: 'utf8', windowsHide: true });

    expect(output.status).toBe(0);
    expect(output.stdout.trim()).toBe('PARSE_OK');
    expect(output.stderr).toBe('');
  });

  it('uses one masked token prompt and no ambient or argument token seam', () => {
    expect(sessionScript.match(/Read-Host 'Temporary Railway project token' -AsSecureString/g))
      .toHaveLength(1);
    expect(sessionScript).toContain("$ProjectorTokenName = 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN'");
    expect(sessionScript).toContain('SecureStringToBSTR');
    expect(sessionScript).toContain('PtrToStringBSTR');
    expect(sessionScript).toContain('ZeroFreeBSTR');
    expect(sessionScript).toContain('$psi.Environment.Clear()');
    expect(sessionScript).toContain('$psi.Environment[$ProjectorTokenName] = $plainToken');
    expect(sessionScript).not.toMatch(/\$env:ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN\s*=/iu);
    expect(sessionScript).not.toContain('ConvertFrom-SecureString');
    expect(sessionScript).not.toContain('Set-Clipboard');
  });

  it('rejects an ambient projector token without echoing it', () => {
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', sessionScriptPath], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...withoutRailwayTokens(),
        ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN: 'test-only-placeholder'
      }
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('GATE_R2_SESSION_AMBIENT_TOKEN_FORBIDDEN');
    expect(`${result.stdout}${result.stderr}`).not.toContain('test-only-placeholder');
  });

  it('pins exact projector and Node identities and limits the session to 14 requests', () => {
    const expected = [
      ['gate-r2-validator-reference-projector.js', '6258CB539D97581696B5DE1710000C1B2DA252888FCBDEEFE24C6BE552F9E797'],
      ['gate-r2-retirement-state-projector.js', '1C022AFBAF7ABBC1B7941A205578A1F14DCF3DB88C35078BBDA7A07E1200CD50']
    ];
    for (const [name, expectedHash] of expected) {
      const actualHash = createHash('sha256')
        .update(readFileSync(new URL(`../scripts/${name}`, import.meta.url)))
        .digest('hex')
        .toUpperCase();
      expect(actualHash).toBe(expectedHash);
      expect(sessionScript).toContain(expectedHash);
    }
    expect(sessionScript).toContain(
      'D14BA95CDCE1EF7DC9AD3AC74949CA5DB38B27378EE30F30A23CF26F9E875A11'
    );
    expect(sessionScript).toContain('$MaximumRequests = 14');
    const invokeBody = sessionScript.slice(
      sessionScript.indexOf('function Invoke-FixedProjector'),
      sessionScript.indexOf('function New-SecureSessionDirectory')
    );
    expect(invokeBody.match(/Assert-FileHash/g)).toHaveLength(3);
    expect(invokeBody.indexOf('Assert-FileHash'))
      .toBeLessThan(invokeBody.indexOf('SecureStringToBSTR'));
  });

  it.each([
    [1, { operation: 'validatorReference', profile: 'migration' }, ['--profile', 'migration-validator']],
    [2, { operation: 'validatorReference', profile: 'compatibility' }, ['--profile', 'compatibility-validator']],
    [3, { operation: 'validatorReference', profile: 'migration' }, ['--profile', 'migration-validator']],
    [4, { operation: 'validatorReference', profile: 'compatibility' }, ['--profile', 'compatibility-validator']],
    [5, { operation: 'validatorReference', profile: 'migration' }, ['--profile', 'migration-validator']],
    [6, { operation: 'validatorReference', profile: 'compatibility' }, ['--profile', 'compatibility-validator']],
    [7, { operation: 'retirementState', phase: 'pre' }, ['--phase', 'pre']],
    [8, { operation: 'retirementState', phase: 'post', profile: 'original-postgres' }, ['--phase', 'post', '--profile', 'original-postgres']],
    [9, { operation: 'retirementState', phase: 'post', profile: 'failed-postgres-r2' }, ['--phase', 'post', '--profile', 'failed-postgres-r2']],
    [10, { operation: 'retirementState', phase: 'post', profile: 'original-redis' }, ['--phase', 'post', '--profile', 'original-redis']],
    [11, { operation: 'retirementState', phase: 'final', profile: 'original-postgres' }, ['--phase', 'final', '--profile', 'original-postgres']],
    [12, { operation: 'retirementState', phase: 'final', profile: 'failed-postgres-r2' }, ['--phase', 'final', '--profile', 'failed-postgres-r2']],
    [13, { operation: 'retirementState', phase: 'final', profile: 'original-redis' }, ['--phase', 'final', '--profile', 'original-redis']]
  ])('maps only fixed ledger request %i', (sequence, requestFields, expectedArguments) => {
    const result = runProjectorArgumentRequest({
      ...requestFields,
      protocolVersion: 1,
      sequence
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const projected = JSON.parse(result.stdout);
    expect(projected.ok).toBe(true);
    const expectedProjector = requestFields.operation === 'validatorReference'
      ? 'gate-r2-validator-reference-projector.js'
      : 'gate-r2-retirement-state-projector.js';
    expect(projected.arguments[0].replaceAll('\\', '/')).toMatch(
      new RegExp(`/scripts/${expectedProjector.replaceAll('.', '\\.')}$`, 'u')
    );
    expect(projected.arguments.slice(1)).toEqual(expectedArguments);
  });

  it('rejects malformed, extended, or caller-selected projector requests', () => {
    for (const request of [
      { operation: 'validatorReference', profile: 'migration-validator', protocolVersion: 1, sequence: 1 },
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 1, serviceId: 'arbitrary' },
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 2 },
      { operation: 'validatorReference', profile: 'compatibility', protocolVersion: 1, sequence: 3 },
      { operation: 'retirementState', phase: 'pre', profile: 'original-postgres', protocolVersion: 1, sequence: 1 },
      { operation: 'retirementState', phase: 'post', protocolVersion: 1, sequence: 1 },
      { operation: 'retirementState', phase: 'post', profile: 'arbitrary', protocolVersion: 1, sequence: 1 },
      { operation: 'retirementState', phase: 'post', profile: 'original-redis', protocolVersion: 1, sequence: 8 },
      { operation: 'retirementState', phase: 'final', profile: 'original-postgres', protocolVersion: 1, sequence: 10 },
      { operation: 'environment', protocolVersion: 1, sequence: 1 },
      { operation: 'retirementState', phase: 'pre', protocolVersion: 2, sequence: 7 },
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 14 }
    ]) {
      const result = runProjectorArgumentRequest(request);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        code: 'GATE_R2_SESSION_REQUEST_INVALID',
        ok: false
      });
    }
  });

  it.each([
    [
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 1 },
      validatorResult('migration', 'ORIGINAL_POSTGRES')
    ],
    [
      { operation: 'validatorReference', profile: 'compatibility', protocolVersion: 1, sequence: 2 },
      validatorResult('compatibility', 'FAILED_POSTGRES_R2')
    ],
    [
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 3 },
      validatorResult('migration', 'POSTGRES_R3')
    ],
    [
      { operation: 'validatorReference', profile: 'compatibility', protocolVersion: 1, sequence: 6 },
      validatorResult('compatibility', 'POSTGRES_R3')
    ],
    [
      { operation: 'retirementState', phase: 'pre', protocolVersion: 1, sequence: 7 },
      retirementResult('pre')
    ],
    [
      { operation: 'retirementState', phase: 'post', profile: 'failed-postgres-r2', protocolVersion: 1, sequence: 9 },
      retirementResult('post', 'failed-postgres-r2')
    ],
    [
      { operation: 'retirementState', phase: 'final', profile: 'original-redis', protocolVersion: 1, sequence: 13 },
      retirementResult('final', 'original-redis')
    ]
  ])('accepts only the projected result contract for ledger step %#', (request, projectedResult) => {
    const result = runProjectorResultAssertion(request, projectedResult);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });

  it.each([
    [
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 1 },
      validatorResult('migration', 'MISSING')
    ],
    [
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 3 },
      validatorResult('migration', 'ORIGINAL_POSTGRES')
    ],
    [
      { operation: 'validatorReference', profile: 'compatibility', protocolVersion: 1, sequence: 4 },
      { ...validatorResult('compatibility', 'POSTGRES_R3'), activeDeploymentCount: 1 }
    ],
    [
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 5 },
      { ...validatorResult('migration', 'POSTGRES_R3'), unexpected: true }
    ],
    [
      { operation: 'retirementState', phase: 'pre', protocolVersion: 1, sequence: 7 },
      { ...retirementResult('pre'), status: 'BLOCKED', reasonCodes: ['REPLACEMENT_STATE_POSTGRES_R3'] }
    ],
    [
      { operation: 'retirementState', phase: 'post', profile: 'original-postgres', protocolVersion: 1, sequence: 8 },
      retirementResult('post', 'original-redis')
    ],
    [
      { operation: 'retirementState', phase: 'final', profile: 'original-postgres', protocolVersion: 1, sequence: 11 },
      { ...retirementResult('final', 'original-postgres'), targets: [{}, {}] }
    ]
  ])('rejects a non-authoritative projector result for ledger step %#', (request, projectedResult) => {
    const result = runProjectorResultAssertion(request, projectedResult);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      code: 'GATE_R2_SESSION_PROJECTOR_RESULT_INVALID',
      ok: false
    });
  });

  it('has no reusable child-launch or Railway mutation seam', () => {
    expect(sessionScript).toContain(
      'function Invoke-FixedProjector([Security.SecureString]$SecureToken, [hashtable]$Request)'
    );
    expect(sessionScript).toContain('Assert-ExactProjectorInvocation $arguments');
    expect(sessionScript).toContain("$NodePath = 'C:\\Program Files\\nodejs\\node.exe'");
    expect(sessionScript).not.toMatch(/function Invoke-FixedProjector\([^)]*\[string\[\]\]\$Arguments/u);
    expect(sessionScript).not.toContain('Invoke-Expression');
    expect(sessionScript).not.toContain('Start-Process');
    expect(sessionScript).not.toMatch(/\$psi\.FileName\s*=.*railway/iu);
    expect(sessionScript).not.toMatch(/Get-Command\s+railway/iu);
    expect(sessionScript).not.toMatch(/\b(?:variable set|environment edit|volume delete|railway up)\b/iu);
  });

  it.each([
    ['stdout-over', 'GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID'],
    ['stderr-over', 'GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID'],
    ['invalid-utf8', 'GATE_R2_SESSION_PROJECTOR_OUTPUT_INVALID'],
    ['timeout', 'GATE_R2_SESSION_PROJECTOR_TIMEOUT']
  ])('fails closed for bounded-process fixture %s', (mode, expectedCode) => {
    const result = runBoundedFixture(mode, mode === 'timeout' ? 100 : 5_000);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(expectedCode);
  });

  it('uses a guarded secure temporary directory and acknowledged cleanup', () => {
    expect(sessionScript).toContain("'arcanos-gate-r2-projector-' + [guid]::NewGuid().ToString('N')");
    expect(sessionScript).toContain('$security.SetAccessRuleProtection($true, $false)');
    expect(sessionScript).toContain('[IO.FileMode]::CreateNew');
    expect(sessionScript).toContain('[IO.FileShare]::None');
    expect(sessionScript).toContain('Wait-ForAcknowledgement $sessionDirectory $sequence');
    expect(sessionScript).toContain("$acknowledgement.status -cne 'consumed'");
    expect(sessionScript).toContain('Remove-SessionDirectoryGuarded $sessionDirectory');
    expect(sessionScript).toContain("'^arcanos-gate-r2-projector-[0-9a-f]{32}$'");
  });

  windowsIt('completes a no-network stop/ack session and removes its session directory', async () => {
    const harnessScript = createHarness({ copyProjectors: true });
    const escapedHarness = harnessScript.replaceAll("'", "''");
    const command = [
      "function global:Read-Host { [CmdletBinding()] param([Parameter(Position=0)][string]$Prompt,[switch]$AsSecureString) ConvertTo-SecureString 'test-only-placeholder' -AsPlainText -Force }",
      `. '${escapedHarness}'`,
      'exit (Invoke-GateR2ProjectorSessionMain)'
    ].join('; ');
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], {
      env: withoutRailwayTokens(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let sessionDirectory;
    let readyMessage;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/\{[^\r\n]*"status":"GATE_R2_PROJECTOR_SESSION_READY"[^\r\n]*\}/u);
      if (match && !sessionDirectory) {
        readyMessage = JSON.parse(match[0]);
        sessionDirectory = readyMessage.sessionDirectory;
        cleanupDirectories.add(sessionDirectory);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end();

    const readyDeadline = Date.now() + 15_000;
    while (!sessionDirectory) {
      if (Date.now() >= readyDeadline) {
        child.kill();
        throw new Error(`session-not-ready:${stderr}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    const expectedSessionScriptSha256 = createHash('sha256')
      .update(readFileSync(harnessScript))
      .digest('hex')
      .toUpperCase();
    expect(readyMessage).toMatchObject({
      protocolVersion: 1,
      status: 'GATE_R2_PROJECTOR_SESSION_READY',
      sessionDirectory,
      sessionProcessId: child.pid,
      sessionScriptSha256: expectedSessionScriptSha256
    });
    expect(readyMessage.sessionProcessIdentity).toMatch(/^[1-9][0-9]{0,19}$/u);
    const readyFile = JSON.parse(readFileSync(join(sessionDirectory, 'ready.json'), 'utf8'));
    expect(readyFile).toMatchObject({
      protocolVersion: 1,
      status: 'ready',
      projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      environmentId: 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
      maximumRequests: 14,
      sessionProcessId: child.pid,
      sessionScriptSha256: expectedSessionScriptSha256
    });
    expect(readyFile.sessionProcessIdentity).toBe(readyMessage.sessionProcessIdentity);

    atomicWriteJson(join(sessionDirectory, 'request-0001.json'), {
      operation: 'stop',
      protocolVersion: 1,
      sequence: 1
    });
    const responsePath = join(sessionDirectory, 'response-0001.json');
    await waitForFile(responsePath);
    expect(JSON.parse(readFileSync(responsePath, 'utf8'))).toEqual({
      completedLedger: false,
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
      child.once('exit', code => {
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

# Phase 2E Gate R private-only data-service replacement runbook

> **Stages 1–9 are historical — do not execute them.** Both one-attempt R2 names
> were consumed. PostgreSQL R2 was later contained, and PostgreSQL R3 plus
> Redis R2 now have committed readiness and combined-isolation evidence.
> Stages 10–13 define the corrected Gate R2 contract only. The bounded tools
> were independently reviewed at commit
> `b299ecc3dbfeabd968b587d07dce7562bbca1b4f`; live execution still requires
> current operator authorization, a clean worktree, and separately entered
> temporary tokens.

Status: **PROCEDURE ONLY — NOT EXECUTED OR AUTHORIZED BY THIS DOCUMENT**

This runbook replaces the credential-compromised PostgreSQL and Redis services
inside the isolated Phase 2E environment without ever creating a public domain
or TCP proxy. It is pinned to Railway CLI `4.30.2`. It does not deploy an
application or validator, run a migration, start an executor, or touch another
environment.

The sanitized source topology is recorded in
`railway-topology-evidence.json`. No credential value, connection string, or
fingerprint is part of this procedure or its evidence.

## Fixed target and identities

| Resource | Name | ID |
| --- | --- | --- |
| Project | `Arcanos` | `7faf44e5-519c-4e73-8d7a-da9f389e6187` |
| Environment | `phase2e-validation-20260717` | `fb99f47d-5ef5-44c1-96c2-acf7b90fab13` |
| Compromised PostgreSQL | `Postgres` | `b7789306-8aef-4113-add5-02883a6cc087` |
| Compromised PostgreSQL volume | — | `35c26093-1e3f-4d34-b699-89c65d2fb92d` |
| Compromised Redis | `Redis` | `434fa5b4-b52c-4caf-aaba-e87c173bf10d` |
| Compromised Redis volume | — | `d3690500-fcc5-4c06-afa6-cf30e91f608d` |
| Inactive migration validator | `phase2e-migration-validator-20260718` | `d8d5181a-2f72-48d7-8413-6f05d113876c` |
| Inactive compatibility validator | `phase2e-compatibility-validator-20260718` | `febdf999-1c96-48df-8e28-c905b8b27082` |

The one-attempt replacement names are:

- `phase2e-postgres-r2-20260718`
- `phase2e-redis-r2-20260718`

If either name already exists, stop. Do not reuse or repair a prior attempt
under this procedure.

## Why the database templates are prohibited

Do not run either of these commands:

```powershell
railway add --database postgres
railway add --database redis
```

Railway's database templates create TCP proxies by default. A proxy that is
removed later still violates the requirement that the replacement never be
publicly exposed. Likewise, do not create a service with `railway add --image`:
that can activate a source before the volume, credential, command, and
networking assertions are complete.

The approved pattern is an empty service first, all private configuration and
volume attachment second, public-exposure proof third, and image activation
last.

## Invariants and immediate stop conditions

Stop without attempting recovery when any of the following is true:

- The linked project or environment ID differs from the fixed IDs above.
- The Railway CLI version differs from `4.30.2` without a fresh help and
  behavior review.
- Production or the Phase 2D environment is selected at any point.
- The target environment reports private networking disabled.
- `ARCANOS V2`, `ARCANOS Worker`, Python, or either validator has an active
  deployment in the target environment.
- Either replacement name already exists.
- An empty replacement service acquires a deployment, source, Railway domain,
  custom domain, or TCP proxy before source activation.
- A replacement contains `DATABASE_PUBLIC_URL`, `REDIS_PUBLIC_URL`, or any
  other `*_PUBLIC_URL` variable.
- A generated credential is empty, reused, printed, written to disk, included
  in a command argument, or included in captured output.
- A replacement deployment is not healthy, has no dedicated volume, or has no
  private endpoint.
- A validator starts or deploys while its reference is changed.
- Any old service/volume ID, replacement ID, or validator ID is ambiguous.
- Railway asks to create a public endpoint, run an application, apply DDL, or
  take an action not expressly covered by Gate R.

Stopping the compromised deployments is intentionally fail-closed. Once they
are stopped, never restart or redeploy them, even if replacement provisioning
fails.

## Stage 0 — use an isolated local CLI link

Resolve the reviewed readiness-wrapper path locally, then create and enter a new
temporary directory before the first Railway command. No Railway link or command
may run from the repository. Do not enable a PowerShell transcript, shell
tracing, or command-history persistence for this session.

```powershell
$ErrorActionPreference = 'Stop'
$projectId = '7faf44e5-519c-4e73-8d7a-da9f389e6187'
$projectName = 'Arcanos'
$environmentId = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13'
$environmentName = 'phase2e-validation-20260717'
$oldPgServiceId = 'b7789306-8aef-4113-add5-02883a6cc087'
$oldRedisServiceId = '434fa5b4-b52c-4caf-aaba-e87c173bf10d'
$oldPgDeploymentId = 'a7940a2c-d7f2-4dbe-9cfd-86655a51def9'
$oldRedisDeploymentId = 'ae1e3b71-a816-4baa-8c37-c3d4c0f28c0e'
$oldPgVolumeId = '35c26093-1e3f-4d34-b699-89c65d2fb92d'
$oldRedisVolumeId = 'd3690500-fcc5-4c06-afa6-cf30e91f608d'
$migrationValidatorId = 'd8d5181a-2f72-48d7-8413-6f05d113876c'
$compatibilityValidatorId = 'febdf999-1c96-48df-8e28-c905b8b27082'
$pgName = 'phase2e-postgres-r2-20260718'
$redisName = 'phase2e-redis-r2-20260718'
$repositoryRoot = (git rev-parse --show-toplevel).Trim()
$readinessWrapper = Join-Path $repositoryRoot 'scripts/gate-r1-postgres-readiness.js'
$redisReadinessWrapper = Join-Path $repositoryRoot 'scripts/gate-r1-redis-readiness.js'
$tcpProxyProjector = Join-Path $repositoryRoot 'scripts/gate-r1-tcp-proxy-projector.js'
$railwayMetadataProjector = Join-Path $repositoryRoot 'scripts/gate-r1-railway-metadata-projector.js'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('arcanos-gate-r-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
Push-Location $scratch
$scratchPath = (Resolve-Path -LiteralPath $scratch).Path

function Assert-GateRTarget {
  if ((Get-Location).Path -ne $scratchPath) { throw 'GATE_R_SCRATCH_LINK_REQUIRED' }
  $link = railway link -p $projectId -e $environmentId --json | ConvertFrom-Json
  try {
    if (
      $LASTEXITCODE -ne 0 -or
      $link.projectId -ne $projectId -or
      $link.projectName -ne $projectName -or
      $link.environmentId -ne $environmentId -or
      $link.environmentName -ne $environmentName
    ) {
      throw 'GATE_R_TARGET_MISMATCH'
    }
  } finally {
    $link = $null
  }
}

Assert-GateRTarget
if ((railway --version).Trim() -ne 'railway 4.30.2') {
  throw 'GATE_R_CLI_VERSION_MISMATCH'
}
```

The installed CLI `4.30.2` link output was checked read-only and contains
`projectId`, `projectName`, `environmentId`, and `environmentName`; the ID
assertion above therefore does not depend on display text. The `ssh`, `variable
set`, `volume add`, `volume delete`, `environment edit`, `service status`, and
`down` option ordering used below was also checked against the installed
`--help` output.

Railway CLI `4.30.2` checks non-terminal stdin before it considers
`--service-config`. An automated invocation with empty stdin therefore ignores
those flags, constructs an empty patch, and returns
`{"staged":false,"committed":false,"message":"No changes to apply"}` without
calling `EnvironmentPatchCommit`. This behavior was verified against the
official `railwayapp/cli` `v4.30.2` source at commit
`7650d29f2295d32c0ed9ef627d1eab6c8e4aaf49`. Every automated Gate R1
`environment edit` below therefore sends one explicit, fixed JSON patch on
stdin, omits `--service-config` and `--stage`, and requires the exact committed
acknowledgement before trusting a fresh service-instance projection.

`Assert-GateRTarget` is mandatory immediately before every Railway mutation,
including each loop iteration and both `railway add` calls. The latter has no
environment option, so the isolated link is part of its security boundary. Do
not run this procedure from the repository's existing Railway link.

Only stable IDs, names, status categories, and counts may be emitted. Do not
invoke any raw environment-configuration or variable-list operation capable of
returning resolved values, even when its output would remain in memory.

## Stage 1 — read-only preflight

1. Use exact-target status, deployment, and volume reads plus separately
   reviewed schema-locked projections that emit only the required non-secret
   fields. Stop before mutation if a required projection is unavailable; raw
   environment configuration and raw variable maps are prohibited.
2. Assert the fixed project/environment/service/volume IDs.
3. Assert the only target-environment service instances are the two data
   services and the two undeployed validators recorded above.
4. Assert both validators have no deployment ID or active status.
5. Through the fixed metadata projector, require exactly one non-deleted private
   network bound to the exact project and environment. After source activation,
   require a non-deleted `ACTIVE` private endpoint bound to each exact
   replacement service instance. Do not read broad environment-config JSON to
   infer private-network availability.
6. Assert both replacement names are absent project-wide.
7. Prove zero current TCP proxies for both old services through exactly one
   reviewed exact-target method:
   - an authenticated Railway dashboard observation showing the exact target
     environment and both services' Public Networking pages with only the
     inactive enablement option and no existing proxy host or port; or
   - one fixed TCP-proxy projector invocation per old service, each returning a
     fresh numeric count of zero. The projector reads only
     `ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN`, verifies that token's exact project
     and environment scope, and never falls back to generic tokens or the
     Railway CLI credential store.
   Do not combine partial results from the two methods; the selected method must
   cover both exact services immediately before mutation.
8. Through other reviewed read-only metadata, require Railway-domain and custom-
   domain counts of `0` for each old data service.
9. Record production service/deployment identities only, for a later unchanged
   comparison. Do not read production variables or logs.

The environment metadata projector is mandatory for Stages 1 and 7. It uses a
fixed Railway Public API query and emits only schema version, observation time,
fixed project/environment identity, project-wide service IDs/names, target
service/deployment/source policy, domain counts, volume identity/state/mount,
names-only variables, and the single live private-network ID. It never requests
variable values, raw environment configuration, repository names, domain names,
endpoint addresses, or logs.

```powershell
$environmentProjection = node $railwayMetadataProjector --environment | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $environmentProjection.projectId -ne $projectId -or
  $environmentProjection.environmentId -ne $environmentId -or
  [string]::IsNullOrWhiteSpace($environmentProjection.privateNetworkId)
) {
  throw 'GATE_R_ENVIRONMENT_METADATA_PROJECTION_FAILED'
}
$privateNetworkId = $environmentProjection.privateNetworkId
```

The projector requires `ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN` to be already
present only in the dedicated process environment. The token must be scoped to
this exact project and environment; the query verifies that scope through
`projectToken`. This runbook does not authorize creating, retrieving, printing,
or persisting a token. If it is unavailable, stop before mutation. Never fall
back to `RAILWAY_TOKEN`, a personal token, the CLI credential store, raw variable
commands, or broad environment configuration.

For the fixed quarantined-service projector mode:

```powershell
$pgProxyProjection = node $tcpProxyProjector --service-id $oldPgServiceId | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_PROXY_PROJECTION_FAILED' }
$redisProxyProjection = node $tcpProxyProjector --service-id $oldRedisServiceId | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_PROXY_PROJECTION_FAILED' }
if (
  $pgProxyProjection.projectId -ne $projectId -or
  $pgProxyProjection.environmentId -ne $environmentId -or
  $pgProxyProjection.serviceId -ne $oldPgServiceId -or
  $pgProxyProjection.tcpProxyCount -ne 0 -or
  $redisProxyProjection.projectId -ne $projectId -or
  $redisProxyProjection.environmentId -ne $environmentId -or
  $redisProxyProjection.serviceId -ne $oldRedisServiceId -or
  $redisProxyProjection.tcpProxyCount -ne 0
) {
  throw 'GATE_R_TCP_PROXY_PRECONDITION_FAILED'
}
```

The fixed quarantined-service TCP-proxy mode accepts only the two compromised
service IDs. It rejects unexpected response fields and never requests, resolves,
displays, or saves variable values. It emits exactly project ID, environment ID,
service ID, UTC observation time, and the integer proxy count.

The same script has a separate replacement mode. That mode requires an exact
replacement profile (`postgres` or `redis`), a dynamically resolved service ID,
and its dynamically resolved service-instance ID. The profile derives the fixed
replacement name; the caller cannot supply or override it. The fixed query binds
the service ID, derived name, project, environment, non-deleted service instance,
and proxy collection before emitting only allowlisted identity fields, UTC
observation time, and the integer proxy count. It rejects the compromised and
validator service IDs.

For the dashboard method, record only the observation time, exact
environment, service identity, absence of an existing proxy host/port, and
presence of the inactive Public access enablement option. Never click that
option. When the dashboard view does not display service IDs, bind the unique
service name to the fixed ID through the sanitized topology artifact and record
that limitation. Dashboard evidence is an allowed old-service precondition only
when it covers both exact services immediately before mutation. It never
substitutes for a fixed replacement-mode projector result and is not sufficient
for dynamically created replacements.

Repeat the selected complete old-service proof method immediately before the
first Stage 3 mutation; historical zero counts, projector results, or screenshots
are not sufficient.

## Stage 2 — verify the R0 quarantine remains effective

Gate R0 already removed both compromised deployments. R1 must only verify that
the quarantine remains effective; it must not restart, redeploy, or repeat the
removal operations:

```powershell
$oldPgStatus = railway service status -s $oldPgServiceId -e $environmentId --json | ConvertFrom-Json
$oldRedisStatus = railway service status -s $oldRedisServiceId -e $environmentId --json | ConvertFrom-Json
$oldPgHistory = railway deployment list -s $oldPgServiceId -e $environmentId --limit 3 --json | ConvertFrom-Json
$oldRedisHistory = railway deployment list -s $oldRedisServiceId -e $environmentId --limit 3 --json | ConvertFrom-Json
if (
  $null -ne $oldPgStatus.deploymentId -or
  $null -ne $oldRedisStatus.deploymentId -or
  ($oldPgHistory | Where-Object id -eq $oldPgDeploymentId).status -ne 'REMOVED' -or
  ($oldRedisHistory | Where-Object id -eq $oldRedisDeploymentId).status -ne 'REMOVED'
) {
  throw 'GATE_R_R0_QUARANTINE_NOT_EFFECTIVE'
}
$oldPgStatus = $oldRedisStatus = $oldPgHistory = $oldRedisHistory = $null
```

Re-read service status. Neither old service may be in `SUCCESS`, `DEPLOYING`,
`BUILDING`, `INITIALIZING`, `WAITING`, or `QUEUED`. Do not continue if either
can accept traffic. Do not restart either service on any later failure.

## Stage 3 — create empty replacement services

Create services without a database template, image, repository, or variables:

```powershell
Assert-GateRTarget
railway add --service $pgName --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_SERVICE_CREATE_FAILED' }
Assert-GateRTarget
railway add --service $redisName --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_SERVICE_CREATE_FAILED' }
```

Resolve each new service ID and service-instance ID by exact name from the fixed
environment metadata projector; require exactly one match. Record only those
four non-secret IDs. From the allowlisted metadata projection and one replacement-
mode TCP-proxy projection per service, assert that both services have:

- no source;
- no deployment;
- no public domain;
- no TCP proxy;
- no variables; and
- an environment-scoped private-network configuration.

If either empty service has become active or public, stop and report the new
IDs. Do not try to repair it in place.

```powershell
$emptyProjection = node $railwayMetadataProjector --environment | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_EMPTY_SERVICE_METADATA_FAILED' }
$pgReplacement = @($emptyProjection.services | Where-Object { $_.serviceName -eq $pgName })
$redisReplacement = @($emptyProjection.services | Where-Object { $_.serviceName -eq $redisName })
if ($pgReplacement.Count -ne 1 -or $redisReplacement.Count -ne 1) {
  throw 'GATE_R_REPLACEMENT_IDENTITY_AMBIGUOUS'
}
$pgServiceId = $pgReplacement[0].serviceId
$pgServiceInstanceId = $pgReplacement[0].serviceInstanceId
$redisServiceId = $redisReplacement[0].serviceId
$redisServiceInstanceId = $redisReplacement[0].serviceInstanceId

$pgEmptyProxyProjection = node $tcpProxyProjector --replacement-profile postgres --service-id $pgServiceId --service-instance-id $pgServiceInstanceId | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $pgEmptyProxyProjection.projectId -ne $projectId -or
  $pgEmptyProxyProjection.environmentId -ne $environmentId -or
  $pgEmptyProxyProjection.replacementProfile -ne 'postgres' -or
  $pgEmptyProxyProjection.serviceName -ne $pgName -or
  $pgEmptyProxyProjection.serviceId -ne $pgServiceId -or
  $pgEmptyProxyProjection.serviceInstanceId -ne $pgServiceInstanceId -or
  $pgEmptyProxyProjection.tcpProxyCount -ne 0
) {
  throw 'GATE_R_POSTGRES_EMPTY_SERVICE_PROXY_FAILED'
}
$redisEmptyProxyProjection = node $tcpProxyProjector --replacement-profile redis --service-id $redisServiceId --service-instance-id $redisServiceInstanceId | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $redisEmptyProxyProjection.projectId -ne $projectId -or
  $redisEmptyProxyProjection.environmentId -ne $environmentId -or
  $redisEmptyProxyProjection.replacementProfile -ne 'redis' -or
  $redisEmptyProxyProjection.serviceName -ne $redisName -or
  $redisEmptyProxyProjection.serviceId -ne $redisServiceId -or
  $redisEmptyProxyProjection.serviceInstanceId -ne $redisServiceInstanceId -or
  $redisEmptyProxyProjection.tcpProxyCount -ne 0
) {
  throw 'GATE_R_REDIS_EMPTY_SERVICE_PROXY_FAILED'
}
```

## Stage 4 — attach fresh dedicated volumes

Use the newly resolved IDs. The global `-s` and `-e` options precede the
`volume add` subcommand in CLI `4.30.2`:

```powershell
Assert-GateRTarget
$pgVolume = railway volume -s $pgServiceId -e $environmentId add -m '/var/lib/postgresql/data' --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_VOLUME_CREATE_FAILED' }
Assert-GateRTarget
$redisVolume = railway volume -s $redisServiceId -e $environmentId add -m '/data' --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_VOLUME_CREATE_FAILED' }
```

Record only new volume IDs and mount paths. Assert each new volume ID differs
from both compromised volume IDs and that exactly one volume is attached to
each replacement. A volume must not be shared across services.

## Stage 5 — generate and install credentials without exposure

Generate two independent 32-byte CSPRNG values. Use base64url so the values can
be embedded safely in private connection references without URL-encoding. Pass
each value through stdin; never place it in the command line.

```powershell
function Set-FreshRailwaySecret([string]$serviceId, [string]$name) {
  $bytes = [byte[]]::new(32)
  $generatedValue = $null
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  try {
    $generatedValue = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    if ([string]::IsNullOrWhiteSpace($generatedValue)) { throw 'GATE_R_SECRET_EMPTY' }
    Assert-GateRTarget
    $generatedValue | railway variable set -s $serviceId -e $environmentId --stdin --skip-deploys --json $name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GATE_R_SECRET_SET_FAILED' }
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $generatedValue = $null
  }
}

Set-FreshRailwaySecret $pgServiceId POSTGRES_PASSWORD
Set-FreshRailwaySecret $redisServiceId REDIS_PASSWORD
[GC]::Collect()
```

PowerShell strings cannot be reliably zeroized. For that reason the session
must remain short-lived and isolated, and the variables must be nulled
immediately. Never echo, compare, hash, fingerprint, serialize, or persist the
new values. Independent CSPRNG generation plus retirement of the old services
is the credential-generation boundary.

## Stage 6 — configure private references with deployment suppressed

All values below are constants or Railway references. No credential value is
present.

```powershell
$pgVariables = @(
  'POSTGRES_USER=postgres',
  'POSTGRES_DB=railway',
  'PGDATA=/var/lib/postgresql/data/pgdata',
  'PGHOST=${{RAILWAY_PRIVATE_DOMAIN}}',
  'PGPORT=5432',
  'PGUSER=${{POSTGRES_USER}}',
  'PGPASSWORD=${{POSTGRES_PASSWORD}}',
  'PGDATABASE=${{POSTGRES_DB}}',
  'DATABASE_URL=postgresql://${{PGUSER}}:${{PGPASSWORD}}@${{PGHOST}}:${{PGPORT}}/${{PGDATABASE}}',
  'SSL_CERT_DAYS=3650',
  'RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60'
)
foreach ($entry in $pgVariables) {
  Assert-GateRTarget
  railway variable set -s $pgServiceId -e $environmentId --skip-deploys --json $entry | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_VARIABLE_SET_FAILED' }
}

$redisVariables = @(
  'REDISHOST=${{RAILWAY_PRIVATE_DOMAIN}}',
  'REDISPORT=6379',
  'REDISUSER=default',
  'REDISPASSWORD=${{REDIS_PASSWORD}}',
  'REDIS_URL=redis://${{REDISUSER}}:${{REDISPASSWORD}}@${{REDISHOST}}:${{REDISPORT}}'
)
foreach ($entry in $redisVariables) {
  Assert-GateRTarget
  railway variable set -s $redisServiceId -e $environmentId --skip-deploys --json $entry | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_VARIABLE_SET_FAILED' }
}
```

The allowed PostgreSQL variable-name set is exactly:

```text
DATABASE_URL
PGDATA
PGDATABASE
PGHOST
PGPASSWORD
PGPORT
PGUSER
POSTGRES_DB
POSTGRES_PASSWORD
POSTGRES_USER
RAILWAY_DEPLOYMENT_DRAINING_SECONDS
SSL_CERT_DAYS
```

The allowed Redis variable-name set is exactly:

```text
REDISHOST
REDISPASSWORD
REDISPORT
REDISUSER
REDIS_PASSWORD
REDIS_URL
```

Use a separately reviewed schema-locked names-only projection to obtain variable
names. The TCP-proxy projector is deliberately incapable of reading variables.
Neither replacement may contain a `*_PUBLIC_URL` key. Both services must still
have no source and no deployment.

Configure the restart policies and Redis start command while both services
still have no source. The three allowed patch profiles below construct the
entire bounded `EnvironmentConfig` object locally. They accept no arbitrary
path or value and never request Railway's broad environment-config view:

```powershell
$redisStartCommand = '/bin/sh -c ''test "$RAILWAY_VOLUME_MOUNT_PATH" = /data && test -n "$REDIS_PASSWORD" && { [ ! -e /data/lost+found ] || rmdir /data/lost+found; } && exec docker-entrypoint.sh redis-server --requirepass "$REDIS_PASSWORD" --save 60 1 --dir /data'''
$pgImage = 'ghcr.io/railwayapp-templates/postgres-ssl:18.4'
$redisImage = 'redis:8.2.1'

function Invoke-GateR1EnvironmentPatch {
  param(
    [Parameter(Mandatory)]
    [ValidateSet('service-configuration', 'postgres-source', 'redis-source')]
    [string]$Profile
  )

  $patch = [ordered]@{ services = [ordered]@{} }
  switch ($Profile) {
    'service-configuration' {
      $patch.services[$pgServiceId] = [ordered]@{
        deploy = [ordered]@{
          restartPolicyType = 'ON_FAILURE'
          restartPolicyMaxRetries = 3
        }
      }
      $patch.services[$redisServiceId] = [ordered]@{
        deploy = [ordered]@{
          startCommand = $redisStartCommand
          restartPolicyType = 'ON_FAILURE'
          restartPolicyMaxRetries = 3
        }
      }
      $commitMessage = 'gate-r: configure private replacement services'
    }
    'postgres-source' {
      $patch.services[$pgServiceId] = [ordered]@{
        source = [ordered]@{ image = $pgImage }
      }
      $commitMessage = 'gate-r: activate private postgres replacement'
    }
    'redis-source' {
      $patch.services[$redisServiceId] = [ordered]@{
        source = [ordered]@{ image = $redisImage }
      }
      $commitMessage = 'gate-r: activate private redis replacement'
    }
  }

  $patchJson = $patch | ConvertTo-Json -Depth 8 -Compress
  $responseLines = $null
  $responseText = $null
  $result = $null
  try {
    Assert-GateRTarget
    $responseLines = @($patchJson | railway environment edit -e $environmentId -m $commitMessage --json 2>&1)
    if ($LASTEXITCODE -ne 0 -or $responseLines.Count -lt 1 -or $responseLines.Count -gt 8) {
      throw 'GATE_R_ENVIRONMENT_PATCH_FAILED'
    }
    $responseText = [string]::Join("`n", @($responseLines | ForEach-Object { [string]$_ }))
    if ([Text.Encoding]::UTF8.GetByteCount($responseText) -gt 4096) {
      throw 'GATE_R_ENVIRONMENT_PATCH_RESULT_INVALID'
    }
    try {
      $result = [string]$responseLines[-1] | ConvertFrom-Json
    } catch {
      throw 'GATE_R_ENVIRONMENT_PATCH_RESULT_INVALID'
    }
    $expectedKeys = @('committed', 'environmentId', 'environmentName', 'message', 'staged')
    $actualKeys = @($result.PSObject.Properties.Name)
    if (
      $result -isnot [pscustomobject] -or
      $actualKeys.Count -ne $expectedKeys.Count -or
      @($expectedKeys | Where-Object { $actualKeys -cnotcontains $_ }).Count -ne 0 -or
      $result.committed -isnot [bool] -or
      $result.committed -ne $true -or
      $result.staged -isnot [bool] -or
      $result.staged -ne $true -or
      $result.environmentId -cne $environmentId -or
      $result.environmentName -cne $environmentName -or
      $result.message -cne $commitMessage
    ) {
      throw 'GATE_R_ENVIRONMENT_PATCH_NOT_COMMITTED'
    }
  } finally {
    $patch = $null
    $patchJson = $null
    $responseLines = $null
    $responseText = $null
    $actualKeys = $null
    $result = $null
  }
}

Invoke-GateR1EnvironmentPatch 'service-configuration'
```

This command contains an environment-variable reference, not a password. It
fails closed unless the mount is exactly `/data`, removes `lost+found` only
when it is an empty directory, and contains no recursive deletion.

## Stage 7 — final pre-activation isolation gate

Immediately rerun `node $railwayMetadataProjector --environment` before either
image is assigned. Its configuration fields are the current service-instance
view; they are not inferred from a broad desired-config object. A successful
commit acknowledgement alone is insufficient. Prove all of the following from
this fresh allowlisted projection and the separate fixed TCP-proxy projections:

- target project and environment IDs still match;
- private networking is enabled;
- the old deployments remain stopped;
- both replacement services have no deployment and no source;
- volumes and mount paths match Stage 4;
- allowed variable-name sets match Stage 6 exactly;
- shared variable names contain no public URL or unexpected credential alias;
- both services use restart policy `ON_FAILURE` with maximum retries `3`;
- PostgreSQL has an unset start-command contract and Redis has the exact
  approved start-command contract;
- no public URL variable exists;
- Railway domain count is `0` for each replacement;
- custom domain count is `0` for each replacement;
- TCP proxy count is `0` for each replacement; and
- validators still have no deployment.

If this gate does not pass, do not activate an image.

Rerun both replacement-mode projections immediately before source activation;
do not reuse the Stage 3 observations:

```powershell
$preActivationProjection = node $railwayMetadataProjector --environment | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $preActivationProjection.projectId -cne $projectId -or
  $preActivationProjection.environmentId -cne $environmentId
) { throw 'GATE_R_PREACTIVATION_METADATA_FAILED' }
$pgPreActivationMatches = @($preActivationProjection.services | Where-Object {
  $_.serviceId -ceq $pgServiceId -and $_.serviceName -ceq $pgName
})
$redisPreActivationMatches = @($preActivationProjection.services | Where-Object {
  $_.serviceId -ceq $redisServiceId -and $_.serviceName -ceq $redisName
})
if ($pgPreActivationMatches.Count -ne 1 -or $redisPreActivationMatches.Count -ne 1) {
  throw 'GATE_R_PREACTIVATION_SERVICE_IDENTITY_FAILED'
}
$pgPreActivationService = $pgPreActivationMatches[0]
$redisPreActivationService = $redisPreActivationMatches[0]
if (
  $pgPreActivationService.sourceKind -cne 'NONE' -or
  $null -ne $pgPreActivationService.latestDeployment -or
  @($pgPreActivationService.activeDeployments).Count -ne 0 -or
  $pgPreActivationService.restartPolicyType -cne 'ON_FAILURE' -or
  $pgPreActivationService.restartPolicyMaxRetries -ne 3 -or
  $pgPreActivationService.startCommandContract -cne 'UNSET' -or
  $redisPreActivationService.sourceKind -cne 'NONE' -or
  $null -ne $redisPreActivationService.latestDeployment -or
  @($redisPreActivationService.activeDeployments).Count -ne 0 -or
  $redisPreActivationService.restartPolicyType -cne 'ON_FAILURE' -or
  $redisPreActivationService.restartPolicyMaxRetries -ne 3 -or
  $redisPreActivationService.startCommandContract -cne 'APPROVED_REDIS'
) { throw 'GATE_R_PREACTIVATION_CONFIGURATION_MISMATCH' }

$pgPreActivationProxy = node $tcpProxyProjector --replacement-profile postgres --service-id $pgServiceId --service-instance-id $pgServiceInstanceId | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $pgPreActivationProxy.projectId -ne $projectId -or
  $pgPreActivationProxy.environmentId -ne $environmentId -or
  $pgPreActivationProxy.replacementProfile -ne 'postgres' -or
  $pgPreActivationProxy.serviceName -ne $pgName -or
  $pgPreActivationProxy.serviceId -ne $pgServiceId -or
  $pgPreActivationProxy.serviceInstanceId -ne $pgServiceInstanceId
) { throw 'GATE_R_POSTGRES_PROXY_PREACTIVATION_FAILED' }
$redisPreActivationProxy = node $tcpProxyProjector --replacement-profile redis --service-id $redisServiceId --service-instance-id $redisServiceInstanceId | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $redisPreActivationProxy.projectId -ne $projectId -or
  $redisPreActivationProxy.environmentId -ne $environmentId -or
  $redisPreActivationProxy.replacementProfile -ne 'redis' -or
  $redisPreActivationProxy.serviceName -ne $redisName -or
  $redisPreActivationProxy.serviceId -ne $redisServiceId -or
  $redisPreActivationProxy.serviceInstanceId -ne $redisServiceInstanceId
) { throw 'GATE_R_REDIS_PROXY_PREACTIVATION_FAILED' }
if (
  $pgPreActivationProxy.tcpProxyCount -ne 0 -or
  $redisPreActivationProxy.tcpProxyCount -ne 0
) { throw 'GATE_R_REPLACEMENT_PROXY_PREACTIVATION_FAILED' }
```

## Stage 8 — activate and verify PostgreSQL first

Only after Stage 7 passes, assign the PostgreSQL source. Do not assign the
Redis source yet.

```powershell
Invoke-GateR1EnvironmentPatch 'postgres-source'
```

Poll only read-only PostgreSQL deployment status, at most 120 times with a
five-second interval (ten minutes maximum). Fail immediately on a terminal
failure category. Require `SUCCESS`, exactly one new deployment, the expected
image, the new dedicated volume and mount, a private endpoint, zero domains,
zero TCP proxies, and no public URL variable. Then run its bounded service-local
authenticated readiness wrapper. The wrapper verifies the exact Railway target
inside the container, uses the service-local `POSTGRES_PASSWORD` only through
`PGPASSWORD`, disables password prompting and startup files, executes only the
`psql` client meta-command `\conninfo`, suppresses child output, and maps every
failure to a fixed code:

```powershell
$pgEndpointProjection = node $railwayMetadataProjector --endpoint --service-id $pgServiceId --service-name $pgName --private-network-id $privateNetworkId | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $pgEndpointProjection.endpointPresent -ne $true -or
  $pgEndpointProjection.endpointSyncStatus -ne 'ACTIVE'
) { throw 'GATE_R_POSTGRES_PRIVATE_ENDPOINT_FAILED' }

$pgActiveProxyProjection = node $tcpProxyProjector --replacement-profile postgres --service-id $pgServiceId --service-instance-id $pgServiceInstanceId | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $pgActiveProxyProjection.projectId -ne $projectId -or
  $pgActiveProxyProjection.environmentId -ne $environmentId -or
  $pgActiveProxyProjection.replacementProfile -ne 'postgres' -or
  $pgActiveProxyProjection.serviceName -ne $pgName -or
  $pgActiveProxyProjection.serviceId -ne $pgServiceId -or
  $pgActiveProxyProjection.serviceInstanceId -ne $pgServiceInstanceId -or
  $pgActiveProxyProjection.tcpProxyCount -ne 0
) {
  throw 'GATE_R_POSTGRES_ACTIVE_PROXY_FAILED'
}

node $readinessWrapper --service-id $pgServiceId
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_HEALTH_FAILED' }
```

Do not replace the wrapper with a direct or verbose `railway ssh` diagnostic.
The CLI may emit resolved environment assignments before remote-command output.
The wrapper's ignored child streams and fixed result codes are the disclosure
boundary; any fixed wrapper failure stops Gate R1 and is investigated locally
with mocks until a separately authorized live attempt.

PostgreSQL must pass the complete health and isolation gate before Redis source
activation. Do not add domains, TCP proxies, repositories, or application
references.

## Stage 9 — activate Redis, then perform combined isolation verification

After PostgreSQL passes Stage 8, assign the Redis source:

```powershell
Invoke-GateR1EnvironmentPatch 'redis-source'
```

Poll only read-only Redis deployment status, at most 120 times with a
five-second interval (ten minutes maximum). Fail immediately on a terminal
failure category. Require `SUCCESS`, exactly one new deployment, the expected
image and start command, the new dedicated volume mounted at `/data`, a private
endpoint, zero domains, zero TCP proxies, and no public URL variable. Then run
its bounded service-local authenticated readiness wrapper. The wrapper verifies
the exact Railway target inside the container, uses the service-local
`REDIS_PASSWORD` only through `REDISCLI_AUTH`, issues only `PING`, requires the
exact `PONG` response, suppresses child output, and maps every failure to a fixed
code:

```powershell
$redisEndpointProjection = node $railwayMetadataProjector --endpoint --service-id $redisServiceId --service-name $redisName --private-network-id $privateNetworkId | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $redisEndpointProjection.endpointPresent -ne $true -or
  $redisEndpointProjection.endpointSyncStatus -ne 'ACTIVE'
) { throw 'GATE_R_REDIS_PRIVATE_ENDPOINT_FAILED' }

$redisActiveProxyProjection = node $tcpProxyProjector --replacement-profile redis --service-id $redisServiceId --service-instance-id $redisServiceInstanceId | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $redisActiveProxyProjection.projectId -ne $projectId -or
  $redisActiveProxyProjection.environmentId -ne $environmentId -or
  $redisActiveProxyProjection.replacementProfile -ne 'redis' -or
  $redisActiveProxyProjection.serviceName -ne $redisName -or
  $redisActiveProxyProjection.serviceId -ne $redisServiceId -or
  $redisActiveProxyProjection.serviceInstanceId -ne $redisServiceInstanceId -or
  $redisActiveProxyProjection.tcpProxyCount -ne 0
) {
  throw 'GATE_R_REDIS_ACTIVE_PROXY_FAILED'
}

node $redisReadinessWrapper --service-id $redisServiceId
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_HEALTH_FAILED' }
```

Do not replace the Redis wrapper with a direct or verbose `railway ssh`
diagnostic. The CLI may emit resolved environment assignments before
remote-command output. The wrapper's ignored child streams and fixed result
codes are the disclosure boundary; any fixed wrapper failure stops Gate R1 and
is investigated locally with mocks until a separately authorized live attempt.

Repeat the Stage 7 checks against both active deployments. Require bounded
restart policy, zero domains, zero TCP proxies, no public URL variables,
distinct new service/volume/deployment IDs, and private endpoints. Record image
identifiers/digests when Railway exposes them. Emit no logs unless a bounded
failure investigation is required; sanitize all output before recording it.
Do not connect an application or validator and do not run SQL, DDL, a migration,
or an execution test.

The final combined check must make two new replacement-mode projector calls and
require both numeric counts to remain zero. Do not reuse either post-activation
observation.

```powershell
$pgFinalProxyProjection = node $tcpProxyProjector --replacement-profile postgres --service-id $pgServiceId --service-instance-id $pgServiceInstanceId | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_FINAL_PROXY_FAILED' }
$redisFinalProxyProjection = node $tcpProxyProjector --replacement-profile redis --service-id $redisServiceId --service-instance-id $redisServiceInstanceId | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_FINAL_PROXY_FAILED' }
if (
  $pgFinalProxyProjection.projectId -ne $projectId -or
  $pgFinalProxyProjection.environmentId -ne $environmentId -or
  $pgFinalProxyProjection.replacementProfile -ne 'postgres' -or
  $pgFinalProxyProjection.serviceName -ne $pgName -or
  $pgFinalProxyProjection.serviceId -ne $pgServiceId -or
  $pgFinalProxyProjection.serviceInstanceId -ne $pgServiceInstanceId -or
  $pgFinalProxyProjection.tcpProxyCount -ne 0 -or
  $redisFinalProxyProjection.projectId -ne $projectId -or
  $redisFinalProxyProjection.environmentId -ne $environmentId -or
  $redisFinalProxyProjection.replacementProfile -ne 'redis' -or
  $redisFinalProxyProjection.serviceName -ne $redisName -or
  $redisFinalProxyProjection.serviceId -ne $redisServiceId -or
  $redisFinalProxyProjection.serviceInstanceId -ne $redisServiceInstanceId -or
  $redisFinalProxyProjection.tcpProxyCount -ne 0
) { throw 'GATE_R_FINAL_REPLACEMENT_PROXY_FAILED' }
```

## Stage 10 — R2 only: fresh combined proof, then inactive-validator cutover

Do not execute this stage under Gate R1. It requires a separate Gate R2
authorization after the committed combined Gate R1 isolation evidence reports
`PASS` and the associated temporary token is revoked.

Immediately before the first Gate R2 mutation, rerun the complete combined
isolation proof with fresh observations. Require:

- PostgreSQL R3 service `7346b3f6-bf3d-46e1-9d66-79f10847ef89`, deployment
  `b5e45d34-19b8-4253-b230-c3ab0b60b0d7`, and volume
  `ce93ced0-0c15-48f9-87fc-d9153ffefdc8` to remain healthy and private-only;
- Redis R2 service `1ac0bd56-50b3-49eb-954c-ea83515ec915`, deployment
  `9f102e53-ef25-46b5-80e8-0243eb1512d6`, and volume
  `983c4f0a-9180-4621-b65e-dfdd0b79f2bd` to remain healthy and private-only;
- zero Railway domains, custom domains, and TCP proxies for both active
  replacements;
- active private endpoints bound to both exact service instances;
- the original PostgreSQL, original Redis, and failed PostgreSQL R2 service to
  remain inactive with zero TCP proxies; and
- applications, workers, validators, daemons, bridges, and executors to remain
  inactive.

The only known consumers are the two inactive validator services:

```text
Migration validator:     d8d5181a-2f72-48d7-8413-6f05d113876c
Compatibility validator: febdf999-1c96-48df-8e28-c905b8b27082
```

Their fixed environment service-instance identities are preserved in
`gate-r2-validator-instance-identity-basis-2026-07-20.json` and must be freshly
revalidated before use:

```text
Migration validator instance:     7a645cbc-dadf-4072-84c1-6f0843fa30d9
Compatibility validator instance: 3c385dd2-c786-4149-9319-2a168a920aa9
```

Before cutover, open a second masked projector session with a second newly
created environment-scoped project token. This session is separate from the
fresh combined-proof session. It permits exactly fourteen requests: two validator
baselines, four validator post-cutover/final projections, one retirement preprojection,
three cumulative service-retirement postprojections, three cumulative final
volume-state projections, and stop plus consumed acknowledgement. Stop,
acknowledge, and revoke this token after the last cumulative projection passes.
The last cumulative projection is also the target-environment Gate C rerun and
must reprove replacements, endpoints, deployment identities, domains, proxies,
variable-name contracts, validator references, and the exact non-deployment
inventory.

The masked token exists only inside the separate projector-session process.
Every mutation wrapper must reject the Gate R2 token if it is present in its
own parent environment, and must execute the mutation inside the exact isolated
scratch link that it just verified.
The committed `scripts/gate-r2-retirement-runner.js` binds the secure session
directory, PID, live OS process-start identity, and current session-script
SHA-256 before invoking `scripts/gate-r2-retirement-coordinator.js`. The
coordinator revalidates the ready contract and enforces the exact fourteen-step
ledger.

Use `scripts/gate-r2-validator-reference-projector.js`. It must be
schema-locked, resolve no variable value, and report only the exact fixed
validator profile/service/service-instance identity, an active deployment count
fixed at zero, a variable count of zero or one, and one fixed reference
category. An additional variable key, including a public-URL key, is a schema
error rather than a projected count. Then use
`scripts/gate-r2-validator-cutover.js` to change only each validator's
`DATABASE_URL` reference, with deployment suppression, to:

```text
${{phase2e-postgres-r3-20260720.DATABASE_URL}}
```

The failed PostgreSQL R2 reference
`${{phase2e-postgres-r2-20260718.DATABASE_URL}}` is prohibited as a cutover
target. The cutover wrapper must bind the exact project, environment, validator
service, and PostgreSQL R3 service identities and must preserve
`--skip-deploys` semantics. It must not accept a resolved connection string.

Project after each cutover and again after both. Require:

- each validator has exactly one `DATABASE_URL` reference to PostgreSQL R3;
- references to the original PostgreSQL and failed PostgreSQL R2 are zero;
- `*_PUBLIC_URL` variable-name count is zero;
- both validator deployment counts remain zero; and
- no Redis consumer or reference was introduced.

If either cutover or projection fails or is ambiguous, keep both validators
inactive and stop. Do not retire any service or volume, do not retry, and do
not perform an unreviewed compensating write.

## Stage 11 — R2 only: one-at-a-time obsolete service-instance retirement

This destructive stage requires explicit authorization naming every target.
It may begin only after Stage 10 proves both validator references point only to
PostgreSQL R3 and both validators remain inactive.

Retire these environment-local service instances, one at a time:

| Order | Role | Service ID |
| --- | --- | --- |
| 1 | Original compromised PostgreSQL | `b7789306-8aef-4113-add5-02883a6cc087` |
| 2 | Failed PostgreSQL R2 replacement | `a2a57da4-a928-427f-be30-d4a68b59a117` |
| 3 | Original compromised Redis | `434fa5b4-b52c-4caf-aaba-e87c173bf10d` |

Use only `scripts/gate-r2-service-instance-retirement.js` for a fixed target
and only `scripts/gate-r2-retirement-state-projector.js` to establish its
result. The retirement wrapper must bind the exact project, environment, and
one allowlisted service ID, perform one service-level `isDeleted` transition,
suppress child output, and return a fixed non-sensitive result. It must not
accept an arbitrary service ID or expose raw Railway configuration.

After each single retirement attempt, project state before proceeding. Require:

- that exact obsolete environment service instance to be absent or deleted;
- its active deployment count and reference count to be zero;
- PostgreSQL R3 and Redis R2 identities, deployments, volumes, endpoints,
  domain counts, and proxy counts to remain unchanged; and
- ARCANOS V2 and ARCANOS Worker to remain absent from the environment;
- both fixed validator instances to remain present and inactive; and
- no other service instance to be deleted or activated.

An ambiguous response authorizes one read-only postprojection, not a retry.
If the target is still present, or any non-target changed, stop. Never recreate
or restart a retired compromised generation.

## Stage 12 — R2 only: separate old-volume disposition

Service-instance retirement does not authorize volume deletion. Handle these
old volumes only after all three obsolete service instances are proven retired:

| Role | Volume ID |
| --- | --- |
| Original PostgreSQL | `35c26093-1e3f-4d34-b699-89c65d2fb92d` |
| Failed PostgreSQL R2 | `2998734d-7530-4f26-b715-cea4780bd437` |
| Original Redis | `d3690500-fcc5-4c06-afa6-cf30e91f608d` |

First project volume state. If Railway already removed an old volume with its
service instance, record it as absent and issue no deletion. If an old volume
remains, it may be deleted only when it is the exact allowlisted ID, appears
exactly once, and is detached. An attached, duplicated, unknown, or ambiguous
volume stops the operation; do not detach it speculatively.

Use only the fixed, schema-locked
`scripts/gate-r2-volume-disposition.js` after the retirement-state projector
categorizes the same exact profile as `RETAINED_DETACHED` and the live
authorization names the reviewed source commit. Do not substitute raw
`railway volume list`, `railway volume delete`, dashboard deletion, or an
arbitrary API call.

Deleting the old PostgreSQL volumes intentionally discards isolated preview
database state, including prior migration-validation ledgers. Committed
sanitized evidence remains the historical record. Gate M must perform a fresh,
separately authorized migration validation against PostgreSQL R3.

## Stage 13 — R2 only: full Gate C isolation rerun and evidence

Gate R2 is complete only after old-volume disposition is complete and the last
cumulative Gate R2 projection supplies a fresh, schema-locked target-environment
Gate C isolation proof. It must prove:

- all three obsolete environment service instances are absent or deleted;
- all three old volume IDs are absent with their disposition recorded;
- no validator, environment variable, or approved reference projection names
  an obsolete service;
- PostgreSQL R3 and Redis R2 remain healthy, private-only, independently
  credentialed, and bound to their distinct replacement volumes;
- both replacements have zero Railway domains, custom domains, TCP proxies,
  and `*_PUBLIC_URL` variable names;
- both private endpoints remain `ACTIVE` and exact deployment verification
  still passes;
- both validators remain undeployed and reference only PostgreSQL R3;
- no application, worker, Python daemon, bridge, provider, or executor started;
- no migration, DDL, SQL, Redis data, ActionPlan, run, claim, or result operation
  occurred; and
- production and Phase 2D retain their preserved stable service and deployment
  identities without any variable, log, data, or endpoint access.

Then stop and acknowledge the Gate R2 projector session and revoke its token
before classifying Gate R2.

The sanitized evidence must distinguish an environment service instance marked
deleted from a project-level service record that Railway retains. It must not
claim project-wide deletion unless the projection proves it.

## Failure containment and rollback

There is no rollback to a compromised or failed generation.

- If fresh combined proof or reference discovery fails, make no mutation.
- If validator cutover fails, keep validators undeployed and retain every old
  service and volume. Do not continue to retirement.
- If one service retirement succeeds and a later retirement fails, preserve
  the observed partial state, make no retry, and request a new decision. Never
  recreate the retired service.
- If an old volume remains attached or ambiguous, preserve it and stop. Never
  detach it speculatively.
- If volume deletion is ambiguous, project its state once and do not retry.
- If an application, worker, validator, daemon, executor, migration, data
  operation, provider call, public endpoint, secret disclosure, or production
  or Phase 2D change occurs, stop immediately.
- Recovery after a destructive step uses a new identity, volume, and credential
  generation under separate approval; it never restores a compromised service.

## Local cleanup

After all secret-bearing variables have been nulled, close the PowerShell
session. Remove only the verified temporary link directory; never run recursive
cleanup against an unverified path.

```powershell
Pop-Location
$resolvedScratch = [IO.Path]::GetFullPath($scratch)
$resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$scratchParent = [IO.Path]::GetDirectoryName($resolvedScratch).TrimEnd([IO.Path]::DirectorySeparatorChar)
$scratchLeaf = [IO.Path]::GetFileName($resolvedScratch)
if (
  -not $scratchParent.Equals($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
  $scratchLeaf -notmatch '^arcanos-gate-r-[0-9a-f]{32}$'
) {
  throw 'GATE_R_LOCAL_CLEANUP_PATH_REJECTED'
}
Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
```

No Railway environment or replacement service is deleted during local cleanup.

## Evidence basis

The procedure was checked against Railway CLI `4.30.2` help and Railway's
official documentation as observed on 2026-07-18:

- [CLI service creation](https://docs.railway.com/cli/add)
- [PostgreSQL deployment behavior](https://docs.railway.com/databases/postgresql)
- [Redis deployment behavior](https://docs.railway.com/databases/redis)
- [Building a database service from an image](https://docs.railway.com/databases/build-a-database-service)
- [Private networking](https://docs.railway.com/networking/private-networking)
- [TCP proxies](https://docs.railway.com/networking/tcp-proxy)
- [Variables and references](https://docs.railway.com/variables)
- [Volumes](https://docs.railway.com/volumes)

If installed CLI help or these contracts change before Gate R is submitted,
the procedure must be reviewed again rather than adapted during execution.

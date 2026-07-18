# Phase 2E Gate R private-only data-service replacement runbook

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

Run from a new temporary directory, never from the repository. Do not enable a
PowerShell transcript, shell tracing, or command-history persistence for this
session.

```powershell
$ErrorActionPreference = 'Stop'
$projectId = '7faf44e5-519c-4e73-8d7a-da9f389e6187'
$environmentId = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13'
$environmentName = 'phase2e-validation-20260717'
$oldPgServiceId = 'b7789306-8aef-4113-add5-02883a6cc087'
$oldRedisServiceId = '434fa5b4-b52c-4caf-aaba-e87c173bf10d'
$oldPgVolumeId = '35c26093-1e3f-4d34-b699-89c65d2fb92d'
$oldRedisVolumeId = 'd3690500-fcc5-4c06-afa6-cf30e91f608d'
$migrationValidatorId = 'd8d5181a-2f72-48d7-8413-6f05d113876c'
$compatibilityValidatorId = 'febdf999-1c96-48df-8e28-c905b8b27082'
$pgName = 'phase2e-postgres-r2-20260718'
$redisName = 'phase2e-redis-r2-20260718'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('arcanos-gate-r-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
Push-Location $scratch

$link = railway link -p $projectId -e $environmentId --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $link.projectId -ne $projectId -or $link.environmentId -ne $environmentId) {
  throw 'GATE_R_TARGET_MISMATCH'
}
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

Only stable IDs, names, status categories, and counts may be emitted. Keep
environment configuration and variable-list JSON in memory and never redirect
it to a file.

## Stage 1 — read-only preflight

1. Read `railway status --json`, `railway service status -a -e
   $environmentId --json`, `railway volume list --json`, and `railway
   environment config -e $environmentId --json` into memory.
2. Assert the fixed project/environment/service/volume IDs.
3. Assert the only target-environment service instances are the two data
   services and the two undeployed validators recorded above.
4. Assert both validators have no deployment ID or active status.
5. Assert `privateNetworkDisabled` is `false`.
6. Assert both replacement names are absent project-wide.
7. Through read-only Railway networking metadata, emit only these counts for
   each old data service: Railway domains `0`, custom domains `0`, TCP proxies
   `0`.
8. Confirm the Railway dashboard's service **Settings → Networking** view also
   shows no public domain and no TCP proxy. CLI `4.30.2` does not expose a
   domain/proxy list command, so this independent read-only check is mandatory.
9. Record production service/deployment identities only, for a later unchanged
   comparison. Do not read production variables or logs.

Do not display the output of `railway variable list --json` or `railway
environment config --json`; both can contain resolved values.

## Stage 2 — contain the known generation first

The environment has no application, executor, active validator, or Phase 2E
application data to preserve. Stop both compromised deployments before creating
new credentials:

```powershell
railway down -s $oldPgServiceId -e $environmentId -y
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_OLD_POSTGRES_STOP_FAILED' }
railway down -s $oldRedisServiceId -e $environmentId -y
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_OLD_REDIS_STOP_FAILED' }
```

Re-read service status. Neither old service may be in `SUCCESS`, `DEPLOYING`,
`BUILDING`, `INITIALIZING`, `WAITING`, or `QUEUED`. Do not continue if either
can accept traffic. Do not restart either service on any later failure.

## Stage 3 — create empty replacement services

Create services without a database template, image, repository, or variables:

```powershell
railway add --service $pgName --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_SERVICE_CREATE_FAILED' }
railway add --service $redisName --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_SERVICE_CREATE_FAILED' }
```

Resolve each new service ID by exact name from `railway status --json`; require
exactly one match. Record only the two non-secret IDs. Assert from environment
configuration and deployment status that both services have:

- no source;
- no deployment;
- no public domain;
- no TCP proxy;
- no variables; and
- an environment-scoped private-network configuration.

If either empty service has become active or public, stop and report the new
IDs. Do not try to repair it in place.

## Stage 4 — attach fresh dedicated volumes

Use the newly resolved IDs. The global `-s` and `-e` options precede the
`volume add` subcommand in CLI `4.30.2`:

```powershell
$pgVolume = railway volume -s $pgServiceId -e $environmentId add -m '/var/lib/postgresql/data' --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_VOLUME_CREATE_FAILED' }
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

Read the variable maps into memory, compare names only, and then clear the
maps. Neither replacement may contain a `*_PUBLIC_URL` key. Both services must
still have no source and no deployment.

Configure the Redis start command while the service still has no source:

```powershell
$restartPolicyType = 'ON_FAILURE'
$restartPolicyMaxRetries = '3'
foreach ($serviceId in @($pgServiceId, $redisServiceId)) {
  railway environment edit -e $environmentId --service-config $serviceId deploy.restartPolicyType $restartPolicyType -m 'gate-r: bound database restart policy before source activation' --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'GATE_R_RESTART_POLICY_SET_FAILED' }
  railway environment edit -e $environmentId --service-config $serviceId deploy.restartPolicyMaxRetries $restartPolicyMaxRetries -m 'gate-r: bound database restart retries before source activation' --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'GATE_R_RESTART_LIMIT_SET_FAILED' }
}

$redisStartCommand = '/bin/sh -c ''test "$RAILWAY_VOLUME_MOUNT_PATH" = /data && test -n "$REDIS_PASSWORD" && { [ ! -e /data/lost+found ] || rmdir /data/lost+found; } && exec docker-entrypoint.sh redis-server --requirepass "$REDIS_PASSWORD" --save 60 1 --dir /data'''
railway environment edit -e $environmentId --service-config $redisServiceId deploy.startCommand $redisStartCommand -m 'gate-r: configure private redis before source activation' --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_START_COMMAND_SET_FAILED' }
```

This command contains an environment-variable reference, not a password. It
fails closed unless the mount is exactly `/data`, removes `lost+found` only
when it is an empty directory, and contains no recursive deletion.

## Stage 7 — final pre-activation isolation gate

Before either image is assigned, prove all of the following from in-memory
environment/service metadata and the Railway networking view:

- target project and environment IDs still match;
- private networking is enabled;
- the old deployments remain stopped;
- both replacement services have no deployment and no source;
- volumes and mount paths match Stage 4;
- allowed variable-name sets match Stage 6 exactly;
- both services use restart policy `ON_FAILURE` with maximum retries `3`;
- no public URL variable exists;
- Railway domain count is `0` for each replacement;
- custom domain count is `0` for each replacement;
- TCP proxy count is `0` for each replacement; and
- validators still have no deployment.

If this gate does not pass, do not activate an image.

## Stage 8 — activate and verify PostgreSQL first

Only after Stage 7 passes, assign the PostgreSQL source. Do not assign the
Redis source yet.

```powershell
$pgImage = 'ghcr.io/railwayapp-templates/postgres-ssl:18.4'

railway environment edit -e $environmentId --service-config $pgServiceId source.image $pgImage -m 'gate-r: activate private postgres replacement' --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_IMAGE_ACTIVATION_FAILED' }
```

Poll only read-only PostgreSQL deployment status, at most 120 times with a
five-second interval (ten minutes maximum). Fail immediately on a terminal
failure category. Require `SUCCESS`, exactly one new deployment, the expected
image, the new dedicated volume and mount, a private endpoint, zero domains,
zero TCP proxies, and no public URL variable. Then run its service-local health
check:

```powershell
railway ssh -p $projectId -e $environmentId -s $pgServiceId sh -lc 'timeout 15s pg_isready -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_POSTGRES_HEALTH_FAILED' }
```

PostgreSQL must pass the complete health and isolation gate before Redis source
activation. Do not add domains, TCP proxies, repositories, or application
references.

## Stage 9 — activate Redis, then perform combined isolation verification

After PostgreSQL passes Stage 8, assign the Redis source:

```powershell
$redisImage = 'redis:8.2.1'
railway environment edit -e $environmentId --service-config $redisServiceId source.image $redisImage -m 'gate-r: activate private redis replacement' --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_IMAGE_ACTIVATION_FAILED' }
```

Poll only read-only Redis deployment status, at most 120 times with a
five-second interval (ten minutes maximum). Fail immediately on a terminal
failure category. Require `SUCCESS`, exactly one new deployment, the expected
image and start command, the new dedicated volume mounted at `/data`, a private
endpoint, zero domains, zero TCP proxies, and no public URL variable. Then run
its service-local health check. The credential remains inside its own container
and is not printed:

```powershell
railway ssh -p $projectId -e $environmentId -s $redisServiceId sh -lc 'REDISCLI_AUTH="$REDIS_PASSWORD" timeout 15s redis-cli -h 127.0.0.1 -p 6379 --no-auth-warning PING'
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_REDIS_HEALTH_FAILED' }
```

Repeat the Stage 7 checks against both active deployments. Require bounded
restart policy, zero domains, zero TCP proxies, no public URL variables,
distinct new service/volume/deployment IDs, and private endpoints. Record image
identifiers/digests when Railway exposes them. Emit no logs unless a bounded
failure investigation is required; sanitize all output before recording it.
Do not connect an application or validator and do not run SQL, DDL, a migration,
or an execution test.

## Stage 10 — cut over inactive validator references without deployment

The only known consumers are two inactive validators. Change only their
`DATABASE_URL` references and suppress deployments:

```powershell
$privatePgReference = 'DATABASE_URL=${{phase2e-postgres-r2-20260718.DATABASE_URL}}'
railway variable set -s $migrationValidatorId -e $environmentId --skip-deploys --json $privatePgReference | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_MIGRATION_VALIDATOR_REFERENCE_FAILED' }
railway variable set -s $compatibilityValidatorId -e $environmentId --skip-deploys --json $privatePgReference | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_COMPATIBILITY_VALIDATOR_REFERENCE_FAILED' }
```

Re-read status and require both validators still have no deployment. Inspect
their variable maps in memory and emit only these facts:

- each contains one `DATABASE_URL` reference to the replacement service;
- neither contains a public URL variable;
- old PostgreSQL reference count is `0`; and
- validator deployment count remains `0`.

No Redis consumer was found in this environment, so no Redis reference is
changed.

## Stage 11 — retire compromised service and volume identities

This stage is destructive and requires explicit Gate R authorization naming
the old IDs. Railway CLI `4.30.2` has no `service delete` subcommand, and
`railway delete` would delete the project. The reviewed target-scoped deletion
path is the environment configuration's service-level `isDeleted` field. It is
safer than a dashboard deletion here because the command binds both the fixed
environment ID and exact service ID and returns JSON for the operation record.

After replacement health, isolation, and validator-reference checks pass:

```powershell
railway environment edit -e $environmentId --service-config $oldPgServiceId isDeleted true -m 'gate-r: retire compromised preview postgres service' --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_OLD_POSTGRES_SERVICE_DELETE_FAILED' }
railway environment edit -e $environmentId --service-config $oldRedisServiceId isDeleted true -m 'gate-r: retire compromised preview redis service' --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_OLD_REDIS_SERVICE_DELETE_FAILED' }
```

1. Re-read Railway status/configuration and require both old service IDs absent
   from the target environment.
2. Run `railway volume list --json` in memory.
3. If an old volume ID disappeared with its service, record it as already
   removed and do not issue a delete.
4. If an old volume ID remains and is detached, delete only that exact ID:

```powershell
$volumeRoot = railway volume -e $environmentId list --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'GATE_R_VOLUME_RELIST_FAILED' }
$oldVolumes = @(
  @{ id = $oldPgVolumeId; failure = 'GATE_R_OLD_POSTGRES_VOLUME_DELETE_FAILED' },
  @{ id = $oldRedisVolumeId; failure = 'GATE_R_OLD_REDIS_VOLUME_DELETE_FAILED' }
)
foreach ($oldVolume in $oldVolumes) {
  $matches = @($volumeRoot.volumes | Where-Object { $_.id -eq $oldVolume.id })
  if ($matches.Count -eq 0) { continue }
  if ($matches.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace($matches[0].serviceName)) {
    throw 'GATE_R_OLD_VOLUME_NOT_UNIQUELY_DETACHED'
  }
  railway volume -e $environmentId delete -v $oldVolume.id -y --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw $oldVolume.failure }
}
$matches = $null
$volumeRoot = $null
```

If Railway requires 2FA, pause and obtain the code out of band. Never put a 2FA
code in Git, a report, a transcript, or chat. If either remaining volume is
attached to any service, stop; do not detach it speculatively.

Service deletion and either conditional volume deletion are prohibited until
the operator submits the separate Gate R authorization request. They were not
performed while this runbook was written.

Deleting the old PostgreSQL volume intentionally discards the isolated
preview database, including its prior migration-validation ledger and schema
state. The sanitized committed evidence remains the historical record. Gate M
must later perform a fresh, separately authorized migration validation against
the replacement database; Gate R does not carry forward or reinterpret the
old database state.

## Stage 12 — containment and non-impact proof

The final sanitized evidence must show:

- both compromised service IDs absent;
- both compromised volume IDs absent;
- no environment configuration or validator reference mentions an old service;
- both replacement services healthy, private-only, and independently
  credentialed;
- both replacement volumes distinct and correctly mounted;
- zero Railway domains, custom domains, and TCP proxies for both replacements;
- no `*_PUBLIC_URL` variables on replacements or validators;
- validators remain undeployed;
- no application, worker, Python daemon, bridge, provider, or executor started;
- no migration or DDL ran;
- no ActionPlan, run, claim, or result was created;
- production and the Phase 2D environment retain the same service/deployment
  identities captured during preflight; and
- no production variable, log, data, or endpoint was read or mutated.

## Failure containment and rollback

There is no rollback to the compromised generation.

- If preflight fails, make no change.
- If stopping one old service fails, stop and report; do not create a
  replacement.
- If an empty replacement violates isolation, stop and leave the old services
  stopped. Delete the failed replacement only under the exact Gate R cleanup
  authority.
- If configuration, volume attachment, image activation, or health fails,
  leave old services stopped and validators undeployed. Do not repair by
  copying an old credential or adding a public proxy.
- If one replacement succeeds and the other fails, keep the successful service
  private and idle; do not cut over validators or retire old identities until a
  new operator decision.
- If validator cutover fails, keep validators undeployed and do not delete old
  service identities until references are proven correct.
- After an old service is deleted, never recreate or restart it. A later
  recovery uses another fresh service name, volume, and credential generation
  under new approval.
- Gate R permits at most one PostgreSQL and one Redis replacement attempt. It
  does not authorize an automatic retry loop.

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

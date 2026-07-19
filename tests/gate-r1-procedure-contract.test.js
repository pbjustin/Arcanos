import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

const runbook = readFileSync(
  new URL(
    '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/private-data-service-replacement-runbook.md',
    import.meta.url
  ),
  'utf8'
);
const authorizationRequest = readFileSync(
  new URL(
    '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/gate-r-authorization-request.md',
    import.meta.url
  ),
  'utf8'
);

describe('Gate R1 procedure contract', () => {
  it('uses an isolated exact-target link and guards every R1 Railway mutation', () => {
    expect(runbook).toContain("$scratch = Join-Path ([IO.Path]::GetTempPath())");
    expect(runbook).toContain('function Assert-GateRTarget');
    expect(runbook).toContain("$link.projectId -ne $projectId");
    expect(runbook).toContain("$link.environmentId -ne $environmentId");

    const r1 = runbook.slice(runbook.indexOf('## Stage 3'), runbook.indexOf('## Stage 10'));
    const lines = r1.split(/\r?\n/);
    const mutationPattern = /railway (?:add --service|volume .* add|variable set|environment edit)/;

    for (let index = 0; index < lines.length; index += 1) {
      if (!mutationPattern.test(lines[index])) continue;
      let prior = index - 1;
      while (prior >= 0 && lines[prior].trim() === '') prior -= 1;
      expect(lines[prior].trim()).toBe('Assert-GateRTarget');
    }
  });

  it('treats R0 as read-only and keeps cutover and retirement outside R1', () => {
    const stage1 = runbook.slice(runbook.indexOf('## Stage 1'), runbook.indexOf('## Stage 2'));
    const stage2 = runbook.slice(runbook.indexOf('## Stage 2'), runbook.indexOf('## Stage 3'));

    expect(stage1).toContain('schema-locked projections');
    expect(stage1).not.toContain('railway environment config');
    expect(stage1).not.toContain('railway variable list');
    expect(runbook).not.toContain('variable maps into memory');
    expect(runbook).toContain('scripts/gate-r1-tcp-proxy-projector.js');
    expect(runbook).toContain('scripts/gate-r1-railway-metadata-projector.js');
    expect(runbook).toContain('ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN');
    expect(stage1).toContain('node $railwayMetadataProjector --environment');
    expect(stage1).not.toContain('privateNetworkDisabled');
    expect(runbook).toContain('endpointSyncStatus -ne \'ACTIVE\'');
    expect(runbook).toContain('does not authorize creating, retrieving, printing,');
    expect(runbook).toContain("$oldRedisDeploymentId = 'ae1e3b71-a816-4baa-8c37-c3d4c0f28c0e'");
    expect(runbook).toContain('The TCP-proxy projector is deliberately incapable of reading variables.');
    expect(stage2).not.toContain('railway down');
    expect(stage2).toContain('GATE_R_R0_QUARANTINE_NOT_EFFECTIVE');
    expect(runbook).toContain('## Stage 10 — R2 only:');
    expect(runbook).toContain('## Stage 11 — R2 only:');
  });

  it('uses the authenticated PostgreSQL wrapper and preserves authenticated Redis readiness', () => {
    expect(authorizationRequest).toContain('Status: **COPY-READY REQUEST — NOT AUTHORIZATION BY THIS DOCUMENT**');
    expect(runbook).not.toContain('pg_isready');
    expect(authorizationRequest).not.toContain('pg_isready');
    expect(runbook).toContain('scripts/gate-r1-postgres-readiness.js');
    expect(runbook).toContain('node $readinessWrapper --service-id $pgServiceId');
    expect(runbook).toContain('`psql` client meta-command `\\conninfo`');
    expect(runbook).toContain('REDISCLI_AUTH="$REDIS_PASSWORD"');
    expect(runbook).toContain('redis-cli -h 127.0.0.1 -p 6379 --no-auth-warning PING >/dev/null 2>&1');
  });

  it('uses exact schema-locked proxy modes for quarantined and replacement services', () => {
    const stage1 = runbook.slice(runbook.indexOf('## Stage 1'), runbook.indexOf('## Stage 2'));
    const stage3 = runbook.slice(runbook.indexOf('## Stage 3'), runbook.indexOf('## Stage 4'));
    const stage7 = runbook.slice(runbook.indexOf('## Stage 7'), runbook.indexOf('## Stage 8'));
    const stage8 = runbook.slice(runbook.indexOf('## Stage 8'), runbook.indexOf('## Stage 9'));
    const stage9 = runbook.slice(runbook.indexOf('## Stage 9'), runbook.indexOf('## Stage 10'));

    expect(stage1).toContain('through exactly one');
    expect(stage1).toMatch(/one fixed TCP-proxy projector invocation per old service/);
    expect(stage1).toContain('--service-id $oldPgServiceId');
    expect(stage1).toContain('--service-id $oldRedisServiceId');
    expect(stage1).toContain('authenticated Railway dashboard observation');
    expect(stage1).toContain('Do not combine partial results from the two methods');

    expect(stage3).toContain('--replacement-profile postgres --service-id $pgServiceId --service-instance-id $pgServiceInstanceId');
    expect(stage3).toContain('--replacement-profile redis --service-id $redisServiceId --service-instance-id $redisServiceInstanceId');
    expect(stage3).toContain('GATE_R_POSTGRES_EMPTY_SERVICE_PROXY_FAILED');
    expect(stage3).toContain('GATE_R_REDIS_EMPTY_SERVICE_PROXY_FAILED');
    expect(stage3).toContain('$pgEmptyProxyProjection.serviceName -ne $pgName');
    expect(stage3).toContain('$redisEmptyProxyProjection.serviceName -ne $redisName');
    expect(stage3).not.toContain('Assert from environment configuration');
    expect(stage3.indexOf('railway add --service $redisName')).toBeLessThan(
      stage3.indexOf('$emptyProjection = node $railwayMetadataProjector --environment')
    );
    expect(stage3.indexOf('$emptyProjection = node $railwayMetadataProjector --environment')).toBeLessThan(
      stage3.indexOf('$pgEmptyProxyProjection = node $tcpProxyProjector')
    );

    expect(stage7).toContain('$pgPreActivationProxy = node $tcpProxyProjector --replacement-profile postgres');
    expect(stage7).toContain('$redisPreActivationProxy = node $tcpProxyProjector --replacement-profile redis');
    expect(stage7).toContain('GATE_R_POSTGRES_PROXY_PREACTIVATION_FAILED');
    expect(stage7).toContain('GATE_R_REDIS_PROXY_PREACTIVATION_FAILED');
    expect(stage7).toContain('GATE_R_REPLACEMENT_PROXY_PREACTIVATION_FAILED');
    expect(stage7).toContain('$pgPreActivationProxy.serviceName -ne $pgName');
    expect(stage7).toContain('$redisPreActivationProxy.serviceName -ne $redisName');
    expect(stage7.indexOf('node $railwayMetadataProjector --environment')).toBeLessThan(
      stage7.indexOf('$pgPreActivationProxy = node $tcpProxyProjector')
    );

    expect(stage8).toContain('$pgActiveProxyProjection = node $tcpProxyProjector --replacement-profile postgres');
    expect(stage8).toContain('GATE_R_POSTGRES_ACTIVE_PROXY_FAILED');
    expect(stage8).toContain('$pgActiveProxyProjection.serviceName -ne $pgName');
    expect(stage8.indexOf('source.image $pgImage')).toBeLessThan(
      stage8.indexOf('$pgActiveProxyProjection = node $tcpProxyProjector')
    );
    expect(stage8.indexOf('$pgActiveProxyProjection = node $tcpProxyProjector')).toBeLessThan(
      stage8.indexOf('node $readinessWrapper --service-id $pgServiceId')
    );
    expect(stage9).toContain('$redisActiveProxyProjection = node $tcpProxyProjector --replacement-profile redis');
    expect(stage9).toContain('GATE_R_REDIS_ACTIVE_PROXY_FAILED');
    expect(stage9).toContain('$redisActiveProxyProjection.serviceName -ne $redisName');
    expect(stage9).toContain('must make two new replacement-mode projector calls');
    expect(stage9).toContain('$pgFinalProxyProjection = node $tcpProxyProjector --replacement-profile postgres');
    expect(stage9).toContain('$redisFinalProxyProjection = node $tcpProxyProjector --replacement-profile redis');
    expect(stage9).toContain('GATE_R_FINAL_REPLACEMENT_PROXY_FAILED');
    expect(stage9.indexOf('source.image $redisImage')).toBeLessThan(
      stage9.indexOf('$redisActiveProxyProjection = node $tcpProxyProjector')
    );
    expect(stage9.indexOf('$redisActiveProxyProjection = node $tcpProxyProjector')).toBeLessThan(
      stage9.indexOf('redis-cli -h 127.0.0.1')
    );
    expect(stage9.indexOf('$redisActiveProxyProjection = node $tcpProxyProjector')).toBeLessThan(
      stage9.indexOf('$pgFinalProxyProjection = node $tcpProxyProjector')
    );
    expect(stage9.indexOf('redis-cli -h 127.0.0.1')).toBeLessThan(
      stage9.indexOf('$pgFinalProxyProjection = node $tcpProxyProjector')
    );

    expect(runbook).toContain('It never\nsubstitutes for a fixed replacement-mode projector result');
    expect(authorizationRequest).toContain('through exactly one current reviewed method');
    expect(authorizationRequest).toContain('Do not combine partial results from the two methods');
    expect(authorizationRequest).toContain('after creation, immediately before source activation, after each service activates, and during the final combined isolation check');
  });
});

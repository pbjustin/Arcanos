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
});

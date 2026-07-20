import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const plan = readFileSync(fileURLToPath(new URL(
  '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/gate-r1-postgres-r3b-plan-2026-07-20.md',
  import.meta.url
)), 'utf8');
const request = readFileSync(fileURLToPath(new URL(
  '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/gate-r1-postgres-r3b1-authorization-request-2026-07-20.md',
  import.meta.url
)), 'utf8');
const evidence = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/gate-r1-postgres-r3a-execution-evidence-2026-07-20.json',
  import.meta.url
)), 'utf8'));
const configurationTool = readFileSync(fileURLToPath(new URL(
  '../scripts/gate-r1-postgres-r3-config-patch.js',
  import.meta.url
)), 'utf8');
const offlineMutationTool = readFileSync(fileURLToPath(new URL(
  '../scripts/gate-r1-postgres-r3-offline-mutation.js',
  import.meta.url
)), 'utf8');

const R3_SERVICE_ID = '7346b3f6-bf3d-46e1-9d66-79f10847ef89';
const R3_INSTANCE_ID = '86dde430-50ac-4d5c-95c3-cb27064eff51';

describe('Gate R1 PostgreSQL R3B procedure contract', () => {
  it('preserves the sanitized R3A identity and limitations as evidence', () => {
    expect(evidence).toMatchObject({
      phase: 'GATE_R1_POSTGRES_R3A',
      result: 'PASS_WITH_LIMITATIONS',
      createdIdentity: {
        serviceId: R3_SERVICE_ID,
        serviceInstanceId: R3_INSTANCE_ID,
        sourceKind: 'NONE',
        activeDeploymentCount: 0,
        volumeCount: 0,
        variableCount: 0
      },
      disclosureScan: { secretLikeMatchCount: 0, connectionStringMatchCount: 0 }
    });
    expect(evidence.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining('TCP-proxy count was intentionally not queried'),
      expect.stringContaining('production and Phase 2D')
    ]));
  });

  it('hard-pins the R3 service, instance, target environment, network, and image', () => {
    for (const value of [
      R3_SERVICE_ID,
      R3_INSTANCE_ID,
      '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
      '464f2194-3825-4ac1-a705-192566561675',
      'ghcr.io/railwayapp-templates/postgres-ssl:18.4',
      '87C3047C7F4A7E8162ED4783592460A226DA322074005BAF1351532A360E5D73'
    ]) {
      expect(plan).toContain(value);
    }
    expect(request).toContain(R3_SERVICE_ID);
    expect(request).toContain(R3_INSTANCE_ID);
  });

  it('splits offline preparation from source activation and readiness', () => {
    expect(plan).toContain('## R3B1 — offline preparation');
    expect(plan).toContain('## R3B2 — source activation and readiness');
    expect(plan).toContain('R3B1 must stop while `sourceKind` remains `NONE`');
    expect(request).toContain('sourceKind remains NONE');
    expect(request).toContain('Not authorized:');
    expect(request).toContain('Image or source assignment, deployment, redeploy, restart, down, readiness, psql, SQL, migration, or application connection.');
    expect(configurationTool).not.toContain("'postgres-source':");
    expect(configurationTool).not.toContain('activate private postgres replacement');
    expect(configurationTool).not.toContain('source: Object.freeze');
  });

  it('requires fresh exact-ID exposure proof and full non-impact evidence', () => {
    for (const text of [
      'fresh exact-ID R3 TCP-proxy count of `0`',
      'original PostgreSQL and Redis, PostgreSQL R2, and Redis R2',
      'production and Phase 2D stable identities',
      'Missing, ambiguous, stale, or nonzero evidence stops the gate'
    ]) {
      expect(plan).toContain(text);
    }
    expect(request).toContain('fresh exact-ID TCP-proxy count of zero');
    expect(request).toContain('Capture sanitized production and Phase 2D stable identities');
  });

  it('limits R3B1 to one volume, one in-memory credential, fixed names, and a PostgreSQL-only patch', () => {
    for (const text of [
      'one fresh environment-local volume',
      'one independent 32-byte CSPRNG `POSTGRES_PASSWORD`',
      'exactly these eleven fixed non-secret or Railway-reference variables',
      '`service-configuration` profile'
    ]) {
      expect(plan).toContain(text);
    }
    expect(request).toContain('Authorized R3B1 mutations, in this order and only against the exact R3 service:');
    expect(request).toContain('Redis mutation or activation.');
    expect(request).toContain('Retry after an ambiguous mutation response.');
    expect(offlineMutationTool).toContain("volume: Object.freeze");
    expect(offlineMutationTool).toContain("credential: Object.freeze");
    expect(offlineMutationTool).toContain("variables: Object.freeze");
    expect(offlineMutationTool).not.toContain("redis:");
  });

  it('pins the four-command mutation plan to a fifteen-request evidence ledger', () => {
    for (const text of [
      '`MaximumRequests=20`',
      'exactly 15 requests',
      '| 13–14 |',
      '| 15 |',
      'five unused requests confer no authority',
      'one ordered `railway variable set` command',
      'R3B1 performs no endpoint query'
    ]) {
      expect(plan).toContain(text);
    }
    expect(request).toContain('exactly four mutation commands are authorized');
    expect(request).toContain('request 15 to stop and acknowledge');
    expect(request).toContain('Do not query an endpoint in R3B1');
    expect(request).toContain('temporary project token is projector-only');
    expect(plan).toContain('gate-r1-postgres-r3-offline-mutation.js --operation volume');
    expect(plan).toContain('gate-r1-postgres-r3-config-patch.js --profile service-configuration');
  });

  it('has no executable dependency on the historical dynamic R2 runbook', () => {
    for (const artifact of [plan, request, configurationTool, offlineMutationTool]) {
      expect(artifact).not.toContain('private-data-service-replacement-runbook');
      expect(artifact).not.toContain('Invoke-GateR1EnvironmentPatch');
      expect(artifact).not.toContain('Set-FreshRailwaySecret');
      expect(artifact).not.toContain('foreach ($entry in $pgVariables)');
    }
  });
});

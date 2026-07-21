import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  GATE_R1_R3_POSTGRES_IMAGE,
  parseGateR1PostgresR3SourceActivationArgs
} from '../scripts/gate-r1-postgres-r3-source-activation.js';
import {
  GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS,
  GATE_R1_R3_DEPLOYMENT_DEADLINE_MS,
  GATE_R1_R3_DEPLOYMENT_POLL_INTERVAL_MS,
  parseGateR1PostgresR3DeploymentStatusArgs
} from '../scripts/gate-r1-postgres-r3-deployment-status.js';

const auditDirectory = '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/';
const plan = readFileSync(fileURLToPath(new URL(
  `${auditDirectory}gate-r1-postgres-r3b-plan-2026-07-20.md`,
  import.meta.url
)), 'utf8');
const evidence = JSON.parse(readFileSync(fileURLToPath(new URL(
  `${auditDirectory}gate-r1-postgres-r3b1-execution-evidence-2026-07-20.json`,
  import.meta.url
)), 'utf8'));
const r3b2Section = plan.slice(
  plan.indexOf('## R3B2 — source activation and readiness'),
  plan.indexOf('## Current stop state')
);
const stopStateSection = plan.slice(plan.indexOf('## Current stop state'));
const normalizedR3b2Section = r3b2Section.replace(/\s+/gu, ' ');

describe('Gate R1 PostgreSQL R3B2 procedure contract', () => {
  it('uses the committed R3B1 evidence and preserves its projected stop state and limitation', () => {
    expect(evidence).toMatchObject({
      phase: 'GATE_R1_POSTGRES_R3B1',
      result: 'PASS_WITH_LIMITATIONS',
      offlineStopState: {
        sourceKind: 'NONE',
        latestDeploymentPresent: false,
        activeDeploymentCount: 0,
        volume: {
          volumeId: 'ce93ced0-0c15-48f9-87fc-d9153ffefdc8',
          volumeInstanceId: 'c7969acf-79fd-4a6b-83d7-1e6cb442a030',
          mountPath: '/var/lib/postgresql/data',
          state: 'READY'
        },
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 3,
        railwayDomainCount: 0,
        customDomainCount: 0,
        tcpProxyCount: 0
      },
      accessControl: { temporaryTokenRevocation: 'OPERATOR_CONFIRMED' }
    });
    expect(evidence.operations[3]).toMatchObject({
      operation: 'SERVICE_CONFIGURATION_PATCH',
      wrapperResult: 'GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID',
      retryCount: 0,
      projectionPassed: true
    });
    expect(r3b2Section).toContain('gate-r1-postgres-r3b1-execution-evidence-2026-07-20.json');
    expect(stopStateSection).toContain('configuration-wrapper result remains invalid historical evidence');
    expect(stopStateSection).toContain('it was\nnot retried or relabeled');
  });

  it('names only the fixed R3B2 wrappers and keeps source assignment as the sole trigger', () => {
    for (const path of [
      'scripts/gate-r1-postgres-r3-source-activation.js --operation activate',
      'scripts/gate-r1-postgres-r3-deployment-status.js --operation wait --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89',
      'scripts/gate-r1-postgres-r3-deployment-status.js --operation verify-success --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --deployment-id <deployment-id-returned-by-wait>',
      'scripts/gate-r1-postgres-readiness.js --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89',
    ]) {
      expect(r3b2Section).toContain(path);
    }
    expect(parseGateR1PostgresR3SourceActivationArgs(['--operation', 'activate']))
      .toEqual({ operation: 'activate' });
    expect(parseGateR1PostgresR3DeploymentStatusArgs([
      '--operation', 'wait', '--service-id', '7346b3f6-bf3d-46e1-9d66-79f10847ef89'
    ])).toMatchObject({ operation: 'wait' });
    expect(parseGateR1PostgresR3DeploymentStatusArgs([
      '--operation', 'verify-success',
      '--service-id', '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
      '--deployment-id', '75e791a9-31cb-40bc-8e39-8970958cf330'
    ])).toMatchObject({ operation: 'verify-success' });
    expect(r3b2Section).toContain('is the only\nallowed deployment trigger');
    expect(r3b2Section).toContain('Do not use `railway up`, redeploy, restart');
    expect(r3b2Section).toContain('any second source\nassignment');
    expect(r3b2Section).toContain('consumes the one attempt and is not retry authorization');
    expect(GATE_R1_R3_POSTGRES_IMAGE).toBe('ghcr.io/railwayapp-templates/postgres-ssl:18.4');
    expect(r3b2Section).toContain(GATE_R1_R3_POSTGRES_IMAGE);
  });

  it('bounds deployment polling and permits exactly one new successful deployment', () => {
    expect(GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS).toBe(120);
    expect(GATE_R1_R3_DEPLOYMENT_POLL_INTERVAL_MS).toBe(5_000);
    expect(GATE_R1_R3_DEPLOYMENT_DEADLINE_MS).toBe(600_000);
    expect(r3b2Section).toContain('at most `120` observations with a fixed five-second sleep');
    expect(r3b2Section).toContain('ten-minute monotonic overall deadline');
    expect(normalizedR3b2Section).toContain('latches the first non-null deployment ID');
    expect(r3b2Section).toContain('Only `SUCCESS` advances the procedure');
    expect(r3b2Section).toContain('exactly one new successful deployment');
    expect(r3b2Section).toContain('Neither operation fetches raw logs or variable\nvalues');
  });

  it('defines the exact fifteen-request success ledger around source, status, and readiness', () => {
    const orderedMarkers = [
      '| 1 | Target-environment metadata and complete R3B1-state validation |',
      '| 2–6 | Original PostgreSQL, original Redis, PostgreSQL R2, Redis R2, and exact PostgreSQL R3 proxy proofs |',
      '| — | Invoke the source-activation wrapper exactly once |',
      '| 7 | Immediate post-source target-environment metadata |',
      '| 8 | Immediate post-source exact R3 proxy proof |',
      '| — | Invoke the deployment-status wrapper, at most 120 polls with a five-second interval, until `SUCCESS` or fail closed |',
      '| 9 | Post-success target-environment metadata |',
      '| 10 | Post-success exact R3 proxy proof |',
      '| 11 | Post-success exact R3 private-endpoint proof |',
      '| — | Verify exact expected deployment ID and `SUCCESS` immediately before readiness |',
      '| — | Invoke the existing authenticated readiness wrapper exactly once |',
      '| — | Verify exact expected deployment ID and `SUCCESS` immediately after readiness |',
      '| 12 | Final target-environment metadata and retained-resource proof |',
      '| 13 | Final exact R3 proxy proof |',
      '| 14 | Final exact R3 private-endpoint proof |',
      '| 15 | Stop and acknowledge the secure session, then revoke the temporary token |'
    ];
    let previousIndex = -1;
    for (const marker of orderedMarkers) {
      const index = r3b2Section.indexOf(marker);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(r3b2Section).toContain('uses exactly 15 requests');
    expect(normalizedR3b2Section).toContain(
      'Deployment-status polling and the two expected-ID verifications are outside the secure projector request count'
    );
  });

  it('pins readiness with expected-ID checks and keeps containment outside R3B2', () => {
    expect(r3b2Section).toContain('may run exactly once and only after\nthe successful deployment');
    expect(normalizedR3b2Section).toContain(
      'bounded authenticated non-SQL `psql \\conninfo`'
    );
    expect(r3b2Section).toContain('R3B2 authorizes no containment mutation');
    expect(r3b2Section).toContain('Do not retry, repair, run `railway down`');
    expect(r3b2Section).toContain('targets the most recent service deployment rather than an\nimmutable deployment ID');
    expect(r3b2Section).not.toContain('gate-r1-postgres-r3-containment.js');
    expect(r3b2Section).toContain('version-tag pinned, not digest immutable');
    expect(r3b2Section).toContain('do not make the service-\ntargeted readiness connection atomic');
  });

  it('keeps Redis and every later gate outside R3B2', () => {
    expect(r3b2Section).toContain('R3B2 does not authorize Redis source assignment, activation, mutation');
    expect(r3b2Section).toContain('Gate R2/V/M/D');
    expect(stopStateSection).toContain('R3B2 execution remains unauthorized');
    expect(stopStateSection).toContain('Redis remains offline and untouched');
  });
});

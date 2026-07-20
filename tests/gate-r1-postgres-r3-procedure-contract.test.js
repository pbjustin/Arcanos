import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

const plan = readFileSync(
  new URL(
    '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/gate-r1-postgres-r3-recovery-plan-2026-07-20.md',
    import.meta.url
  ),
  'utf8'
);
const requestDocument = readFileSync(
  new URL(
    '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/gate-r1-postgres-r3-authorization-request-2026-07-20.md',
    import.meta.url
  ),
  'utf8'
);

describe('Gate R1 PostgreSQL R3A identity-creation contract', () => {
  it('uses one fresh one-attempt identity and preserves R2 evidence', () => {
    expect(plan).toContain('phase2e-postgres-r3-20260720');
    expect(plan).toContain('If the R3 name already exists, stop');
    expect(plan).toContain('does not rewrite the historical R2 runbook or\nevidence');
    expect(requestDocument).toContain('create one empty service named phase2e-postgres-r3-20260720');
    expect(requestDocument).toContain('Creating any additional PostgreSQL or Redis service');
  });

  it('pins every retained service and volume and forbids Redis mutation', () => {
    for (const id of [
      'b7789306-8aef-4113-add5-02883a6cc087',
      '35c26093-1e3f-4d34-b699-89c65d2fb92d',
      '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
      'd3690500-fcc5-4c06-afa6-cf30e91f608d',
      'a2a57da4-a928-427f-be30-d4a68b59a117',
      '2998734d-7530-4f26-b715-cea4780bd437',
      '1ac0bd56-50b3-49eb-954c-ea83515ec915',
      '983c4f0a-9180-4621-b65e-dfdd0b79f2bd'
    ]) {
      expect(plan).toContain(id);
      expect(requestDocument).toContain(id);
    }
    expect(plan).toContain('R3A does not activate, configure,\nrestart, replace, or otherwise mutate Redis');
    expect(requestDocument).toContain('Redis activation, deployment, credentials, configuration, restart, replacement, or deletion');
  });

  it('authorizes exactly one empty-service mutation and then stops', () => {
    const authorized = requestDocument.slice(
      requestDocument.indexOf('Authorized work:'),
      requestDocument.indexOf('Not authorized:')
    );
    expect(authorized).toContain('Perform exactly one data-service/infrastructure mutation');
    expect(authorized).toContain('create one empty service');
    expect(authorized).toContain('Stop immediately after the unique empty identity is observed');
    for (const forbiddenImperative of [
      'Create and attach', 'Generate one', 'Configure only', 'Apply only',
      'Activate only', 'Deploy', 'Restart', 'Run psql', 'Contain'
    ]) {
      expect(authorized).not.toContain(forbiddenImperative);
    }
  });

  it('expressly defers every data-bearing or runtime operation', () => {
    const prohibited = requestDocument.slice(requestDocument.indexOf('Not authorized:'));
    for (const expected of [
      'Volume creation', 'Credential generation', 'Variable reads or writes',
      'configuration or environment patches', 'Source or image assignment',
      'deploy, redeploy, restart, down', 'readiness/psql',
      'TCP-proxy or domain creation', 'Redis activation'
    ]) {
      expect(prohibited).toContain(expected);
    }
    expect(prohibited).toContain('Gate R1 R3B, Gate R2, Gate V, Gate M, Gate D');
  });

  it('requires fresh schema-locked targeting and a bounded temporary token lifecycle', () => {
    for (const value of [
      '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
      '464f2194-3825-4ac1-a705-192566561675',
      'ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN'
    ]) {
      expect(plan).toContain(value);
    }
    expect(plan).toContain('One temporary environment-scoped Railway project token may be created');
    expect(plan).toContain('revoked immediately and removed from the process environment');
    expect(plan).toContain('access-control operations recorded separately from the single data-service\nmutation');
    expect(requestDocument).toContain('separately bounded temporary-token create/revoke lifecycle');
    expect(plan).toContain('No historical count satisfies this preflight');
  });

  it('does not claim dynamic R3 proxy proof and makes exact-ID proof an R3B prerequisite', () => {
    expect(plan).toContain('R3A does not claim a current TCP-proxy count');
    expect(plan).toContain('fresh exact-ID TCP-proxy count of zero is a mandatory R3B precondition');
    expect(plan).toContain('pin the newly observed R3 service and service-instance IDs');
    expect(requestDocument).toContain('R3A does not establish the new service\'s TCP-proxy count');
    expect(requestDocument).toContain('without separate explicit approval');
  });

  it('retains a partial empty identity unchanged instead of repairing or containing it', () => {
    expect(plan).toContain('retain the empty service\nunchanged');
    expect(requestDocument).toContain('retain any empty R3 service unchanged');
    expect(requestDocument).toContain('Do not contain, repair, retry, delete');
  });
});

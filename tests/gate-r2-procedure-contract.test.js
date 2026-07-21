import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';

const auditDirectory = new URL(
  '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/',
  import.meta.url
);
const runbook = readFileSync(
  new URL('private-data-service-replacement-runbook.md', auditDirectory),
  'utf8'
);
const procedure = readFileSync(
  new URL('gate-r2-retirement-procedure-2026-07-20.md', auditDirectory),
  'utf8'
);
const validatorIdentityBasis = JSON.parse(readFileSync(
  new URL('gate-r2-validator-instance-identity-basis-2026-07-20.json', auditDirectory),
  'utf8'
));
const normalized = procedure.replace(/\s+/gu, ' ');

function ordered(text, markers) {
  let previous = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('Gate R2 cutover and retirement procedure contract', () => {
  it('records the reviewed implementation while keeping live mutation separately authorized', () => {
    expect(procedure).toContain('Status: **READY FOR AUTHORIZED LIVE EXECUTION**');
    expect(procedure).toContain('b299ecc3dbfeabd968b587d07dce7562bbca1b4f');
    expect(procedure).toContain('This document does not itself authorize Railway mutation');
    expect(runbook).toContain('**Stages 1–9 are historical — do not execute them.**');
    expect(runbook).toContain('Stages 10–13 define the corrected Gate R2 contract only');
    for (const path of [
      'scripts/gate-r2-validator-reference-projector.js',
      'scripts/gate-r2-fixed-link.js',
      'scripts/gate-r2-validator-cutover.js',
      'scripts/gate-r2-service-instance-retirement.js',
      'scripts/gate-r2-retirement-state-projector.js',
      'scripts/gate-r2-volume-disposition.js',
      'scripts/gate-r2-projector-session-20260720.ps1',
      'scripts/gate-r2-retirement-coordinator.js',
      'scripts/gate-r2-retirement-runner.js'
    ]) {
      expect(procedure).toContain(path);
      expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
    }
    expect(normalized).toContain('Raw Railway volume listing or deletion is not an approved substitute');
    expect(normalized).toContain('live OS process-start identity');
  });

  it('cuts inactive validators over only to PostgreSQL R3 with deployment suppression', () => {
    const stage10 = runbook.slice(runbook.indexOf('## Stage 10'), runbook.indexOf('## Stage 11'));

    for (const value of [
      'd8d5181a-2f72-48d7-8413-6f05d113876c',
      'febdf999-1c96-48df-8e28-c905b8b27082',
      '${{phase2e-postgres-r3-20260720.DATABASE_URL}}',
      'scripts/gate-r2-validator-reference-projector.js',
      'scripts/gate-r2-validator-cutover.js'
    ]) {
      expect(stage10).toContain(value);
      expect(procedure).toContain(value);
    }
    expect(stage10).toContain(
      '${{phase2e-postgres-r2-20260718.DATABASE_URL}}` is prohibited as a cutover'
    );
    expect(procedure).toContain('Prohibited reference target:');
    expect(normalized).toContain('The wrapper must preserve deployment suppression');
    expect(normalized).toContain('zero obsolete PostgreSQL references');
    expect(normalized).toContain('zero public-URL variable names, and zero deployments');
    expect(normalized).toContain('a variable count of zero or one');
    expect(normalized).toContain('An additional variable key is a schema error');
    expect(procedure).not.toMatch(/postgres(?:ql)?:\/\//iu);
  });

  it('pins every active, obsolete, and inactive-consumer identity used by the projector', () => {
    for (const value of [
      'phase2e-postgres-r3-20260720',
      '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
      '86dde430-50ac-4d5c-95c3-cb27064eff51',
      'b5e45d34-19b8-4253-b230-c3ab0b60b0d7',
      'ghcr.io/railwayapp-templates/postgres-ssl:18.4',
      'ce93ced0-0c15-48f9-87fc-d9153ffefdc8',
      'c7969acf-79fd-4a6b-83d7-1e6cb442a030',
      'phase2e-redis-r2-20260718',
      '1ac0bd56-50b3-49eb-954c-ea83515ec915',
      '0f34bcbb-bfd0-4df5-954a-bb97371bd460',
      '9f102e53-ef25-46b5-80e8-0243eb1512d6',
      'redis:8.2.1',
      '983c4f0a-9180-4621-b65e-dfdd0b79f2bd',
      'b96f20a3-a1f1-40ea-ba4b-334ea3e8ba15',
      'Postgres',
      'b7789306-8aef-4113-add5-02883a6cc087',
      '6dac21a3-ad8a-4b98-ad50-637054c13729',
      '35c26093-1e3f-4d34-b699-89c65d2fb92d',
      'b8f04086-2e97-4167-a0fd-bcb259541e9f',
      'phase2e-postgres-r2-20260718',
      'a2a57da4-a928-427f-be30-d4a68b59a117',
      'e8c42bea-d887-485b-8aaf-ba0f45d439e8',
      '2998734d-7530-4f26-b715-cea4780bd437',
      '46113532-5609-46da-b7b4-46b8f06930cc',
      'Redis',
      '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
      '8340f02f-dbcb-4c0e-bdde-b3f7c4bf5856',
      'd3690500-fcc5-4c06-afa6-cf30e91f608d',
      'f222873c-255e-45a2-9a17-840bdba108f6',
      'ARCANOS V2',
      'c4ade025-3f13-4fca-9309-5d0dd81396fe',
      'ARCANOS Worker',
      '1765befb-b805-4051-9af9-28634e986886',
      'phase2e-migration-validator-20260718',
      'd8d5181a-2f72-48d7-8413-6f05d113876c',
      '7a645cbc-dadf-4072-84c1-6f0843fa30d9',
      'phase2e-compatibility-validator-20260718',
      'febdf999-1c96-48df-8e28-c905b8b27082',
      '3c385dd2-c786-4149-9319-2a168a920aa9'
    ]) {
      expect(procedure).toContain(value);
    }
  });

  it('preserves the schema-locked runtime basis for both inactive validator instances', () => {
    expect(validatorIdentityBasis).toEqual({
      schemaVersion: 1,
      observedAt: '2026-07-20T00:28:25.403Z',
      observationType: 'runtime',
      source: 'operator-supplied schema-locked Gate R1 metadata projection',
      projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      environmentId: 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
      validators: [
        {
          profile: 'compatibility-validator',
          serviceId: 'febdf999-1c96-48df-8e28-c905b8b27082',
          serviceInstanceId: '3c385dd2-c786-4149-9319-2a168a920aa9',
          activeDeploymentCount: 0
        },
        {
          profile: 'migration-validator',
          serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c',
          serviceInstanceId: '7a645cbc-dadf-4072-84c1-6f0843fa30d9',
          activeDeploymentCount: 0
        }
      ],
      sensitiveValuesRecorded: false,
      productionDeploymentRequired: false
    });
    expect(normalized).toContain('Every Gate R2 use must freshly revalidate them');
    expect(JSON.stringify(validatorIdentityBasis)).not.toMatch(
      /postgres(?:ql)?:\/\/|redis:\/\/|Bearer|Authorization|password|token|secret/iu
    );
  });

  it('orders proof, cutover, per-service postprojection, volume disposition, and Gate C', () => {
    ordered(procedure, [
      '### 1. Fresh combined isolation proof',
      '### 2. Validator reference baseline',
      '### 3. Validator cutover with deployment suppression',
      '### 4. One-at-a-time service-instance retirement',
      'After every single retirement attempt',
      '### 5. Separate volume disposition',
      '### 6. Full Gate C isolation rerun'
    ]);
    ordered(procedure, [
      '1. migration-validator reference baseline;',
      '2. compatibility-validator reference baseline;',
      '3. migration-validator reference projection after its cutover;',
      '4. compatibility-validator reference projection after its cutover;',
      '5. migration-validator reference projection after both cutovers;',
      '6. compatibility-validator reference projection after both cutovers;',
      '7. retirement-state preprojection;',
      '8. retirement postprojection through original PostgreSQL;',
      '9. retirement postprojection through failed PostgreSQL R2;',
      '10. retirement postprojection through original Redis;',
      '11. cumulative final-state projection after original PostgreSQL volume',
      '12. cumulative final-state projection after failed PostgreSQL R2 volume',
      '13. cumulative final-state projection after original Redis volume disposition',
      '14. stop plus consumed acknowledgement.'
    ]);

    expect(normalized).toContain('Do not begin the next retirement until the postprojection passes');
    expect(normalized).toContain(
      'A lost or ambiguous acknowledgement authorizes one read-only postprojection and no retry'
    );
    expect(normalized).toContain('Do not claim that a project-level service record was deleted');
    expect(normalized).toContain('Gate R2 may be classified `PASS` only when every old service and volume');
    expect(normalized).toContain('permits exactly the following fourteen requests');
    expect(normalized).toContain('Requests 11–13 use the cumulative final retirement state');
    expect(normalized).toContain('Request 13 is also the final target-environment Gate C projection');
    expect(normalized).toContain('do not open another token session merely to repeat the same target projection');
    expect(normalized).toContain('A proxy on any inactive consumer blocks the ledger');
    expect(normalized).toContain(
      'session PID, live OS process-start identity, and committed session-script SHA-256'
    );
    expect(normalized).toContain('the coordinator must revalidate the same ready contract');
  });

  it('keeps service retirement separate from old-volume disposition', () => {
    const stage11 = runbook.slice(runbook.indexOf('## Stage 11'), runbook.indexOf('## Stage 12'));
    const stage12 = runbook.slice(runbook.indexOf('## Stage 12'), runbook.indexOf('## Stage 13'));

    expect(stage11).toContain('scripts/gate-r2-service-instance-retirement.js');
    expect(stage11).toContain('scripts/gate-r2-retirement-state-projector.js');
    expect(stage11).not.toContain('gate-r2-volume-disposition.js');
    expect(stage11).not.toMatch(/^\s*railway volume .*delete/mu);

    expect(stage12).toContain('scripts/gate-r2-volume-disposition.js');
    expect(stage12).toContain('RETAINED_DETACHED');
    expect(stage12).toContain('do not detach it speculatively');
    expect(stage12).not.toMatch(/^\s*railway volume .*delete/mu);
  });

  it('fails closed without application, migration, executor, provider, or cross-environment effects', () => {
    for (const phrase of [
      'perform no mutation',
      'keep validators inactive',
      'do not retry',
      'Never recreate or restart a retired generation',
      'Deploying or restarting ARCANOS V2, ARCANOS Worker',
      'Applying a migration, DDL, application SQL, or a Redis data operation',
      'Creating an ActionPlan, execution run, claim, or result',
      'Calling OpenAI or another provider',
      'Modifying production or Phase 2D'
    ]) {
      expect(procedure).toContain(phrase);
    }
    expect(normalized).toContain(
      'zero application, worker, validator, daemon, executor, migration, SQL, Redis data, ActionPlan, and provider effects'
    );
  });

  it('requires sanitized evidence and contains no credential material', () => {
    for (const phrase of [
      'fresh combined proof observations and token revocation',
      'one record per service retirement',
      'one record per old volume',
      'the full Gate C projection',
      'production and Phase 2D non-impact evidence',
      'disclosure counts, all zero'
    ]) {
      expect(procedure).toContain(phrase);
    }
    for (const pattern of [
      /redis:\/\//iu,
      /Bearer\s+\S+/iu,
      /Authorization\s*[:=]/iu,
      /(?:DATABASE|REDIS)(?:_PUBLIC)?_URL\s*=/iu
    ]) {
      expect(procedure).not.toMatch(pattern);
    }
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  GATE_R1_R3_DEPLOYMENT_DEADLINE_MS,
  GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS,
  GATE_R1_R3_DEPLOYMENT_POLL_INTERVAL_MS
} from '../scripts/gate-r1-postgres-r3-deployment-status.js';
import { GATE_R1_R3_POSTGRES_IMAGE } from '../scripts/gate-r1-postgres-r3-source-activation.js';

const documentText = readFileSync(fileURLToPath(new URL(
  '../docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/gate-r1-postgres-r3b2-authorization-request-2026-07-20.md',
  import.meta.url
)), 'utf8');
const normalized = documentText.replace(/\s+/gu, ' ');

describe('Gate R1 PostgreSQL R3B2 copy-ready authorization contract', () => {
  it('pins the reviewed history and exact Railway target', () => {
    for (const value of [
      '13442a020588ac7d42e1d724441cfb2438367d65',
      '3905ab7d9a31537b8043c118ab3b2010ef3d88da',
      '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
      '464f2194-3825-4ac1-a705-192566561675',
      '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
      '86dde430-50ac-4d5c-95c3-cb27064eff51',
      'ce93ced0-0c15-48f9-87fc-d9153ffefdc8',
      'c7969acf-79fd-4a6b-83d7-1e6cb442a030',
      GATE_R1_R3_POSTGRES_IMAGE
    ]) {
      expect(documentText).toContain(value);
    }
  });

  it('authorizes one source trigger and executable bounded deployment checks', () => {
    expect(documentText).toContain(
      'node scripts/gate-r1-postgres-r3-source-activation.js --operation activate'
    );
    expect(documentText).toContain(
      'node scripts/gate-r1-postgres-r3-deployment-status.js --operation wait --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89'
    );
    expect(documentText).toContain(
      'node scripts/gate-r1-postgres-r3-deployment-status.js --operation verify-success --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --deployment-id <latched-id>'
    );
    expect(GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS).toBe(120);
    expect(GATE_R1_R3_DEPLOYMENT_POLL_INTERVAL_MS).toBe(5_000);
    expect(GATE_R1_R3_DEPLOYMENT_DEADLINE_MS).toBe(600_000);
    expect(normalized).toContain('Invoke exactly once:');
    expect(normalized).toContain('This is the only deployment trigger authorized');
    expect(normalized).toContain('Parse its JSON structurally in memory');
    expect(normalized).toContain('Do not ask the operator to copy or retype the ID');
  });

  it('orders the exact success ledger around readiness and token revocation', () => {
    const markers = [
      '1     target metadata and complete R3B1-state validation',
      '2–6   original PostgreSQL, original Redis, PostgreSQL R2, Redis R2, R3 proxy proofs',
      '—     source-activation wrapper exactly once',
      '7     immediate post-source target metadata',
      '8     immediate post-source R3 proxy proof',
      '—     bounded wait wrapper; structurally retain its deployment ID',
      '9     post-success metadata; require the latched ID as the sole active R3 deployment',
      '10    post-success R3 proxy proof',
      '11    post-success R3 private-endpoint proof',
      '—     exact-ID verify-success',
      '—     readiness wrapper exactly once',
      '—     exact-ID verify-success again',
      '12    final target metadata and retained-resource/non-impact proof',
      '13    final R3 proxy proof',
      '14    final R3 private-endpoint proof',
      '15    stop and acknowledge the secure session',
      '—     revoke the temporary token and clear the process environment'
    ];
    let previous = -1;
    for (const marker of markers) {
      const index = documentText.indexOf(marker);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(normalized).toContain(
      'Production and Phase 2D stable-identity comparison reads occur outside the target-bound projector session'
    );
  });

  it('fails closed without containment or scope expansion', () => {
    expect(normalized).toContain('R3B2 authorizes no containment mutation');
    expect(normalized).toContain('does not authorize a retry');
    expect(normalized).toContain('Do not retry, repair, run `railway down`');
    expect(normalized).toContain('Redis source assignment, activation, readiness, mutation, or deployment');
    expect(normalized).toContain('Production or Phase 2D mutation');
    expect(normalized).toContain('Git push, pull request, merge, or repository-source changes');
  });

  it('contains no credential or connection-string material', () => {
    for (const pattern of [
      /postgres(?:ql)?:\/\//iu,
      /redis:\/\//iu,
      /Bearer\s+\S+/iu,
      /Authorization\s*[:=]/iu,
      /(?:DATABASE|REDIS)(?:_PUBLIC)?_URL\s*=/iu
    ]) {
      expect(documentText).not.toMatch(pattern);
    }
  });
});

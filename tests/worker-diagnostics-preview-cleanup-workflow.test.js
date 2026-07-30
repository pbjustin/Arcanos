import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const workflowPath = path.join(
  repositoryRoot,
  '.github',
  'workflows',
  'railway-worker-diagnostics-preview-cleanup.yml'
);

describe('Railway worker-diagnostics preview cleanup workflow', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  it('runs trusted close cleanup without checking out pull request code', () => {
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('- closed');
    expect(workflow).toContain("github.repository == 'pbjustin/Arcanos'");
    expect(workflow).toContain("github.event.pull_request.base.ref == 'main'");
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toContain('github.event.pull_request.head');
  });

  it('uses minimal permissions, a pinned runtime, and one dedicated cleanup token', () => {
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).toContain("node-version: '20.19.0'");
    expect(workflow).toContain('@railway/cli@4.30.2');
    expect(workflow).toContain(
      'RAILWAY_API_TOKEN: ${{ secrets.RAILWAY_WORKER_DIAGNOSTICS_CLEANUP_API_TOKEN }}'
    );
    expect(workflow).not.toContain('RAILWAY_TOKEN:');
  });

  it('binds cleanup to the exact project, PR name, and approved topology', () => {
    expect(workflow).toContain(
      'EXPECTED_RAILWAY_PROJECT_ID: 7faf44e5-519c-4e73-8d7a-da9f389e6187'
    );
    expect(workflow).toContain(
      'EXPECTED_PRODUCTION_ENVIRONMENT_ID: fb583147-6c39-4343-9267-500f357d25ab'
    );
    expect(workflow).toContain(
      'worker-diagnostics-pr-${prNumber}-e2e'
    );
    for (const serviceId of [
      'c4ade025-3f13-4fca-9309-5d0dd81396fe',
      '1765befb-b805-4051-9af9-28634e986886',
      '6647b5b1-d796-4783-b5f0-b8e356019ca6',
      '81e4a1cf-7ae4-48bf-8321-23641bb23c0e',
    ]) {
      expect(workflow).toContain(serviceId);
    }
    expect(workflow).toContain('Production environment deletion is forbidden.');
    expect(workflow).toContain(
      'Railway token visibility is insufficient to prove the target is absent.'
    );
    expect(workflow).toContain(
      'railway environment delete "${TARGET_ENVIRONMENT_ID}" --yes --json'
    );
  });

  it('fails closed on ambiguity and verifies the target disappeared', () => {
    expect(workflow).toContain(
      'Disposable environment identity is ambiguous.'
    );
    expect(workflow).toContain(
      'Disposable Railway environment remained visible after deletion.'
    );
    expect(workflow).not.toContain('|| true');
  });
});

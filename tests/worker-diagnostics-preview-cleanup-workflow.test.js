import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

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
  const parsedWorkflow = yaml.load(workflow.replaceAll('\r\n', '\n'));
  const cleanupStep = parsedWorkflow.jobs.cleanup.steps.find(
    step =>
      step.name ===
      'Delete the exact disposable environment through Railway API'
  );
  const cleanupProgram = cleanupStep.run.match(
    /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE\s*$/u
  )?.[1];

  function runCleanupProgram(fetchMockSource) {
    const env = {
      ...process.env,
      RAILWAY_API_TOKEN: 'workspace-token-for-test-only-000000000000',
      PR_NUMBER: '99999',
      EXPECTED_RAILWAY_PROJECT_ID:
        '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      EXPECTED_RAILWAY_WORKSPACE_ID:
        '1c9265a3-986f-4304-ad3e-5a874caab039',
      EXPECTED_PRODUCTION_ENVIRONMENT_ID:
        'fb583147-6c39-4343-9267-500f357d25ab',
    };
    delete env.RAILWAY_TOKEN;
    return spawnSync(
      process.execPath,
      ['--input-type=module'],
      {
        cwd: repositoryRoot,
        env,
        input: `${fetchMockSource}\n${cleanupProgram}`,
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
  }

  it('runs trusted close cleanup without checking out pull request code', () => {
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('- closed');
    expect(workflow).toContain("github.repository == 'pbjustin/Arcanos'");
    expect(workflow).toContain("github.event.pull_request.base.ref == 'main'");
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toContain('github.event.pull_request.head');
  });

  it('uses minimal permissions, a pinned runtime, and one step-scoped cleanup token', () => {
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).toContain("node-version: '24.18.1'");
    expect(workflow).toContain(
      'RAILWAY_API_TOKEN: ${{ secrets.RAILWAY_WORKER_DIAGNOSTICS_CLEANUP_API_TOKEN }}'
    );
    const cleanupJob = parsedWorkflow.jobs.cleanup;
    expect(cleanupJob.env.RAILWAY_API_TOKEN).toBeUndefined();
    const tokenSteps = cleanupJob.steps.filter(
      step => step.env?.RAILWAY_API_TOKEN !== undefined
    );
    expect(tokenSteps).toHaveLength(1);
    expect(tokenSteps[0]).toMatchObject({
      name: 'Delete the exact disposable environment through Railway API',
      env: {
        RAILWAY_API_TOKEN:
          '${{ secrets.RAILWAY_WORKER_DIAGNOSTICS_CLEANUP_API_TOKEN }}',
      },
    });
    expect(workflow).not.toContain('RAILWAY_TOKEN:');
    expect(workflow).not.toContain('@railway/cli');
    expect(workflow).not.toContain('npm install');
    expect(workflow).not.toContain('railway link');
    expect(workflow).not.toContain('railway status');
  });

  it('binds direct API cleanup to the exact workspace, project, PR name, and approved topology', () => {
    expect(workflow).toContain(
      'https://backboard.railway.com/graphql/v2'
    );
    expect(workflow).toContain("node --input-type=module <<'NODE'");
    expect(workflow).toContain("redirect: 'error'");
    expect(workflow).toContain('signal: AbortSignal.timeout(10_000)');
    expect(workflow).toContain('authorization: `Bearer ${token}`');
    expect(workflow).toContain(
      'EXPECTED_RAILWAY_WORKSPACE_ID: 1c9265a3-986f-4304-ad3e-5a874caab039'
    );
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
      'Railway cleanup token is not scoped only to the expected workspace.'
    );
    expect(workflow).toContain(
      'Account-wide Railway cleanup tokens are forbidden.'
    );
    expect(workflow).toContain('environmentDelete(id: $id)');
    expect(workflow).toContain('/var/lib/postgresql/data');
    expect(workflow).toContain("['81e4a1cf-7ae4-48bf-8321-23641bb23c0e', '/data']");
    expect(workflow).not.toContain('railway environment delete');
  });

  it('fails closed on ambiguity or truncated topology and verifies the target disappeared', () => {
    expect(workflow).toContain(
      'Disposable environment identity is ambiguous.'
    );
    expect(workflow).toContain(
      'Disposable environment topology exceeds the inspection limit.'
    );
    expect(workflow).toContain(
      'target.serviceInstances?.pageInfo?.hasNextPage'
    );
    expect(workflow).toContain(
      'target.volumeInstances?.pageInfo?.hasNextPage'
    );
    expect(workflow).toContain(
      'Disposable environment identity changed after deletion.'
    );
    expect(workflow).toContain(
      'Disposable Railway environment remained visible after deletion.'
    );
    expect(workflow).not.toContain('|| true');
  });

  it('behaviorally rejects an account-wide token before environment access', () => {
    const result = runCleanupProgram(`
      globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        if (!request.query.includes('query CleanupTokenType')) {
          throw new Error('Account token reached an environment operation.');
        }
        return new Response(
          JSON.stringify({
            data: {
              me: {
                id: 'account-user-id',
              },
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          }
        );
      };
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Account-wide Railway cleanup tokens are forbidden.'
    );
    expect(result.stderr).not.toContain(
      'Account token reached an environment operation.'
    );
  });

  it('behaviorally accepts a workspace token and absent target', () => {
    const result = runCleanupProgram(`
      globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        if (request.query.includes('query CleanupTokenType')) {
          return new Response(
            JSON.stringify({
              data: {
                me: null,
              },
              errors: [
                {
                  message: 'Not authorized to query account identity.',
                },
              ],
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
            }
          );
        }
        if (request.query.includes('query CleanupContext')) {
          return new Response(
            JSON.stringify({
              data: {
                apiToken: {
                  workspaces: [
                    {
                      id: '1c9265a3-986f-4304-ad3e-5a874caab039',
                    },
                  ],
                },
                project: {
                  id: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
                  workspaceId:
                    '1c9265a3-986f-4304-ad3e-5a874caab039',
                },
                environments: {
                  edges: [
                    {
                      cursor: 'production-cursor',
                      node: {
                        id: 'fb583147-6c39-4343-9267-500f357d25ab',
                        name: 'production',
                        projectId:
                          '7faf44e5-519c-4e73-8d7a-da9f389e6187',
                        sourceEnvironment: null,
                      },
                    },
                  ],
                  pageInfo: {
                    endCursor: 'production-cursor',
                    hasNextPage: false,
                  },
                },
              },
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
            }
          );
        }
        throw new Error('Unexpected Railway GraphQL operation.');
      };
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'No disposable Railway environment exists for PR 99999.'
    );
  });
});

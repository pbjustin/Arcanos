import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';
import {
  INACTIVE_ROLLOUT_HOLD,
  buildRolloutConfirmation,
  evaluateCoordinatedRolloutGuard,
  renderGitHubOutputs,
} from '../scripts/railway-coordinated-rollout-guard.mjs';

const ACTIVE_HOLD = '20260830-job-events-worker-budget-v1';
const workflowText = readFileSync(
  '.github/workflows/railway-auto-deploy.yml',
  'utf8',
).replaceAll('\r\n', '\n');
const guardText = readFileSync(
  'scripts/railway-coordinated-rollout-guard.mjs',
  'utf8',
).replaceAll('\r\n', '\n');
const workflow = yaml.load(workflowText);
const TRUSTED_PROMOTION_PROVENANCE =
  "(github.event_name == 'workflow_dispatch' "
  + "&& github.ref == format('refs/heads/{0}', github.event.repository.default_branch)) "
  + "|| (github.event_name == 'workflow_run' "
  + "&& github.event.workflow_run.event == 'push' "
  + "&& github.event.workflow_run.conclusion == 'success' "
  + '&& github.event.workflow_run.head_branch == github.event.repository.default_branch '
  + '&& github.event.workflow_run.head_repository.full_name == github.repository '
  + '&& github.event.workflow_run.head_sha == github.sha)';

function isTrustedPromotionProvenance({
  eventName,
  ref,
  repository = 'pbjustin/Arcanos',
  defaultBranch = 'main',
  workflowRun,
}) {
  if (eventName === 'workflow_dispatch') {
    return ref === `refs/heads/${defaultBranch}`;
  }
  return Boolean(
    eventName === 'workflow_run'
    && workflowRun?.event === 'push'
    && workflowRun?.conclusion === 'success'
    && workflowRun?.headBranch === defaultBranch
    && workflowRun?.headRepository === repository
    && workflowRun?.headSha === workflowRun?.workflowSha
  );
}

function job(name) {
  const value = workflow.jobs?.[name];
  expect(value).toBeDefined();
  return value ?? {};
}

function namedStep(jobName, stepName) {
  const value = job(jobName).steps?.find(step => step.name === stepName);
  expect(value).toBeDefined();
  return value ?? {};
}

describe('Railway coordinated writer rollout policy', () => {
  it('fails closed when the repository hold marker is absent or malformed', () => {
    for (const holdId of [undefined, '', ' none', 'NONE', 'bad hold']) {
      expect(() =>
        evaluateCoordinatedRolloutGuard({
          eventName: 'workflow_run',
          holdId,
        }),
      ).toThrow(/COORDINATED_WRITER_ROLLOUT_HOLD_(?:REQUIRED|INVALID)/u);
    }
  });

  it('preserves automatic promotion only for the explicit inactive sentinel', () => {
    expect(
      evaluateCoordinatedRolloutGuard({
        eventName: 'workflow_run',
        holdId: INACTIVE_ROLLOUT_HOLD,
      }),
    ).toEqual({
      shouldDeploy: true,
      holdActive: false,
      holdId: INACTIVE_ROLLOUT_HOLD,
      reason: 'hold_inactive',
    });
  });

  it('keeps automatic promotion blocked by the exact worker-budget hold until reviewed removal', () => {
    const repositoryHold =
      workflow.env?.ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD;
    expect(repositoryHold).toBe(ACTIVE_HOLD);
    expect(repositoryHold).not.toBe(INACTIVE_ROLLOUT_HOLD);
    expect(
      evaluateCoordinatedRolloutGuard({
        eventName: 'workflow_run',
        holdId: repositoryHold,
      }),
    ).toEqual({
      shouldDeploy: false,
      holdActive: true,
      holdId: ACTIVE_HOLD,
      reason: 'automatic_promotion_blocked',
    });
  });

  it('requires the exact hold-bound drained-writers phrase for manual dispatch', () => {
    const expectedConfirmation = buildRolloutConfirmation(ACTIVE_HOLD);

    for (const manualConfirmation of [
      '',
      'COORDINATED WRITERS DRAINED',
      expectedConfirmation.toLowerCase(),
      `${expectedConfirmation} `,
      `COORDINATED WRITERS DRAINED: another-hold`,
    ]) {
      expect(() =>
        evaluateCoordinatedRolloutGuard({
          eventName: 'workflow_dispatch',
          holdId: ACTIVE_HOLD,
          manualConfirmation,
        }),
      ).toThrow('COORDINATED_WRITER_ROLLOUT_CONFIRMATION_REQUIRED');
    }

    expect(
      evaluateCoordinatedRolloutGuard({
        eventName: 'workflow_dispatch',
        holdId: ACTIVE_HOLD,
        manualConfirmation: expectedConfirmation,
      }),
    ).toEqual({
      shouldDeploy: true,
      holdActive: true,
      holdId: ACTIVE_HOLD,
      reason: 'manual_drain_confirmation_accepted',
    });
  });

  it('emits only bounded workflow outputs and never reflects confirmation input', () => {
    const output = renderGitHubOutputs(
      evaluateCoordinatedRolloutGuard({
        eventName: 'workflow_dispatch',
        holdId: ACTIVE_HOLD,
        manualConfirmation: buildRolloutConfirmation(ACTIVE_HOLD),
      }),
    );

    expect(output).toBe(
      [
        'should_deploy=true',
        'hold_active=true',
        `hold_id=${ACTIVE_HOLD}`,
        'reason=manual_drain_confirmation_accepted',
        '',
      ].join('\n'),
    );
    expect(output).not.toContain('COORDINATED WRITERS DRAINED');
  });

  it('wires the repository hold through a preflight job before deploy concurrency', () => {
    expect(workflow.env?.ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD).toBe(
      ACTIVE_HOLD,
    );
    expect(Object.keys(workflow.jobs ?? {})).toEqual([
      'rollout-policy',
      'deploy-production',
      'inspect-production',
    ]);

    const policyJob = job('rollout-policy');
    const deployJob = job('deploy-production');
    const guardStep = namedStep(
      'rollout-policy',
      'Enforce coordinated writer rollout policy',
    );

    expect(policyJob.concurrency).toBeUndefined();
    expect(policyJob.outputs?.should_deploy).toContain(
      'steps.rollout_guard.outputs.should_deploy',
    );
    expect(guardStep.id).toBe('rollout_guard');
    expect(guardStep.run).toBe(
      'node scripts/railway-coordinated-rollout-guard.mjs',
    );
    expect(guardStep.env).toMatchObject({
      ARCANOS_DEPLOY_EVENT_NAME: '${{ github.event_name }}',
      ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD:
        '${{ env.ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD }}',
      ARCANOS_COORDINATED_WRITER_ROLLOUT_CONFIRMATION:
        "${{ github.event.inputs.coordinated_writer_rollout_confirmation || '' }}",
    });
    expect(`${workflowText}\n${guardText}`).not.toMatch(
      /ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD|ARCANOS_DAG_WRITER_ROLLOUT_CONFIRMATION|dag_writer_rollout_confirmation|DAG WRITERS DRAINED|COORDINATED_DAG_WRITER_ROLLOUT/u,
    );

    expect(deployJob.needs).toBe('rollout-policy');
    expect(deployJob.if).toContain(
      "needs.rollout-policy.outputs.should_deploy == 'true'",
    );
    expect(deployJob.concurrency).toEqual({
      group: 'railway-auto-deploy-production',
      'cancel-in-progress': false,
    });
    expect(deployJob['timeout-minutes']).toBe(130);
  });

  it('runs privileged promotion only from trusted default-branch push provenance', () => {
    const policyJob = job('rollout-policy');
    const deployJob = job('deploy-production');
    const policyCheckout = namedStep(
      'rollout-policy',
      'Checkout rollout policy',
    );

    expect(policyJob.env?.DEPLOY_REF).toBeUndefined();
    expect(policyCheckout.with).toEqual({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    });
    expect(policyJob.if).toBe(
      `(${TRUSTED_PROMOTION_PROVENANCE}) `
      + "&& (github.event.inputs.operation || 'deploy') == 'deploy'",
    );
    expect(deployJob.env?.DEPLOY_REF).toBe('${{ github.sha }}');
    expect(deployJob.if).toBe(
      "needs.rollout-policy.outputs.should_deploy == 'true' "
      + `&& (${TRUSTED_PROMOTION_PROVENANCE}) `
      + "&& (github.event.inputs.operation || 'deploy') == 'deploy'",
    );
  });

  it('rechecks the live default tip after concurrency and before Railway credentials', () => {
    const deployJob = job('deploy-production');
    const steps = deployJob.steps ?? [];
    const liveTipStep = namedStep(
      'deploy-production',
      'Verify deploy ref is current default tip',
    );
    const firstRailwayTokenIndex = steps.findIndex(step =>
      Object.hasOwn(step.env ?? {}, 'RAILWAY_TOKEN'),
    );
    const liveTipIndex = steps.indexOf(liveTipStep);

    expect(deployJob.env?.DEFAULT_BRANCH).toBe(
      '${{ github.event.repository.default_branch }}',
    );
    expect(liveTipIndex).toBeGreaterThan(
      steps.findIndex(step => step.name === 'Checkout'),
    );
    expect(firstRailwayTokenIndex).toBeGreaterThan(liveTipIndex);
    expect(liveTipStep.env).toBeUndefined();
    expect(liveTipStep.run).toContain(
      'git ls-remote --exit-code --refs origin "refs/heads/${DEFAULT_BRANCH}"',
    );
    expect(liveTipStep.run).toContain(
      'if [ "${live_default_sha}" != "${DEPLOY_REF}" ]; then',
    );
    expect(liveTipStep.run).toContain(
      'RAILWAY_DEPLOY_REF_NOT_CURRENT_DEFAULT_TIP',
    );
  });

  it.each([
    [
      'fork source branch named main',
      {
        eventName: 'workflow_run',
        workflowRun: {
          event: 'pull_request',
          conclusion: 'success',
          headBranch: 'main',
          headRepository: 'attacker/Arcanos',
          headSha: 'a',
          workflowSha: 'b',
        },
      },
      false,
    ],
    [
      'same-repository non-push run',
      {
        eventName: 'workflow_run',
        workflowRun: {
          event: 'pull_request',
          conclusion: 'success',
          headBranch: 'main',
          headRepository: 'pbjustin/Arcanos',
          headSha: 'a',
          workflowSha: 'a',
        },
      },
      false,
    ],
    [
      'stale main push',
      {
        eventName: 'workflow_run',
        workflowRun: {
          event: 'push',
          conclusion: 'success',
          headBranch: 'main',
          headRepository: 'pbjustin/Arcanos',
          headSha: 'a',
          workflowSha: 'b',
        },
      },
      false,
    ],
    [
      'current main push',
      {
        eventName: 'workflow_run',
        workflowRun: {
          event: 'push',
          conclusion: 'success',
          headBranch: 'main',
          headRepository: 'pbjustin/Arcanos',
          headSha: 'a',
          workflowSha: 'a',
        },
      },
      true,
    ],
    [
      'manual feature branch',
      { eventName: 'workflow_dispatch', ref: 'refs/heads/feature' },
      false,
    ],
    [
      'manual tag',
      { eventName: 'workflow_dispatch', ref: 'refs/tags/v1.0.0' },
      false,
    ],
    [
      'manual default branch',
      { eventName: 'workflow_dispatch', ref: 'refs/heads/main' },
      true,
    ],
  ])('classifies %s provenance', (_name, event, expected) => {
    expect(isTrustedPromotionProvenance(event)).toBe(expected);
  });

  it('keeps the conditional manual input and every Railway action behind the job gate', () => {
    const dispatchInput =
      workflow.on?.workflow_dispatch?.inputs
        ?.coordinated_writer_rollout_confirmation;
    expect(dispatchInput?.required).toBe(false);
    expect(dispatchInput?.description).toContain(
      buildRolloutConfirmation(ACTIVE_HOLD),
    );

    const deployJob = job('deploy-production');
    expect(deployJob.if).toContain(
      "needs.rollout-policy.outputs.should_deploy == 'true'",
    );

    const deployStepNames = [
      'Verify paired Railway targets',
      'Deploy and verify Railway worker',
      'Deploy and verify Railway web pair',
      'Post-deploy web watchdog/budget regression check',
    ];
    for (const stepName of deployStepNames) {
      expect(namedStep('deploy-production', stepName)).toBeDefined();
    }
  });
});

describe('Railway read-only production inspection admission', () => {
  it('separates manual inspection from every deployment gate and retains the hold', () => {
    expect(workflow.on.workflow_dispatch.inputs.operation).toEqual({
      description: 'Deploy the approved pair or collect read-only production evidence',
      required: true,
      default: 'deploy',
      type: 'choice',
      options: ['deploy', 'inspect'],
    });
    expect(workflow.env.ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD).toBe(ACTIVE_HOLD);
    for (const jobName of ['rollout-policy', 'deploy-production']) {
      expect(job(jobName).if).toContain(
        "(github.event.inputs.operation || 'deploy') == 'deploy'",
      );
    }
    const inspection = job('inspect-production');
    expect(inspection.if).toBe(
      "github.event_name == 'workflow_dispatch' "
      + "&& github.ref == format('refs/heads/{0}', github.event.repository.default_branch) "
      + "&& github.event.inputs.operation == 'inspect'",
    );
    expect(inspection.permissions).toEqual({ contents: 'read' });
    expect(inspection['timeout-minutes']).toBe(5);
    expect(inspection.concurrency).toEqual({
      group: 'railway-auto-deploy-production',
      'cancel-in-progress': false,
    });
    expect(inspection.env.RAILWAY_TOKEN).toBeUndefined();
    expect(namedStep('inspect-production', 'Checkout read-only inspection').with).toEqual({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    });
  });

  it('checks current default tip and installs dependencies before exposing the token', () => {
    const steps = job('inspect-production').steps;
    const tip = namedStep('inspect-production', 'Verify inspection ref is current default tip');
    const install = namedStep('inspect-production', 'Install inspection dependencies');
    const collect = namedStep('inspect-production', 'Collect bounded read-only production receipt');
    expect(collect.id).toBe('inspection');
    expect(tip.run).toContain('git ls-remote --exit-code --refs origin');
    expect(tip.run).toContain('RAILWAY_DEPLOY_REF_NOT_CURRENT_DEFAULT_TIP');
    expect(tip.env).toBeUndefined();
    expect(install.run).toBe('npm ci --ignore-scripts --no-audit --no-fund');
    expect(install.env).toBeUndefined();
    expect(steps.indexOf(tip)).toBeLessThan(steps.indexOf(collect));
    expect(steps.indexOf(install)).toBeLessThan(steps.indexOf(collect));
    expect(collect.env).toEqual({
      RAILWAY_TOKEN: '${{ secrets.RAILWAY_PRODUCTION_PROJECT_TOKEN }}',
    });
    expect(collect.run).toBe('node scripts/railway-production-readonly-inspection.mjs');
    expect(steps.map(step => step.run ?? '').join('\n')).not.toMatch(
      /\benqueue\b|railway (?:up|redeploy|restart|ssh|connect)|\bALTER\b|\bCREATE\b|npm (?:start|run build)/u,
    );
    const artifact = namedStep('inspect-production', 'Preserve sanitized inspection receipt');
    expect(artifact.if).toBe("always() && steps.inspection.outputs.inspection_receipt_written == 'true'");
    expect(artifact.with.path).toBe('${{ runner.temp }}/production-readonly-inspection.json');
    expect(artifact.with['if-no-files-found']).toBe('error');
    expect(artifact.with['retention-days']).toBe(7);
    expect(artifact.env).toBeUndefined();
  });
});

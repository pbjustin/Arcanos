import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';
import {
  INACTIVE_ROLLOUT_HOLD,
  buildRolloutConfirmation,
  evaluateCoordinatedRolloutGuard,
  renderGitHubOutputs,
} from '../scripts/railway-coordinated-rollout-guard.mjs';

const ACTIVE_HOLD = '20260727-dag-snapshot-generation-v1';
const workflowText = readFileSync(
  '.github/workflows/railway-auto-deploy.yml',
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

describe('Railway coordinated DAG writer rollout policy', () => {
  it('fails closed when the repository hold marker is absent or malformed', () => {
    for (const holdId of [undefined, '', ' none', 'NONE', 'bad hold']) {
      expect(() =>
        evaluateCoordinatedRolloutGuard({
          eventName: 'workflow_run',
          holdId,
        }),
      ).toThrow(/COORDINATED_DAG_WRITER_ROLLOUT_HOLD_(?:REQUIRED|INVALID)/u);
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

  it('skips automatic promotion while the coordinated writer hold is active', () => {
    expect(
      evaluateCoordinatedRolloutGuard({
        eventName: 'workflow_run',
        holdId: ACTIVE_HOLD,
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
      'DAG WRITERS DRAINED',
      expectedConfirmation.toLowerCase(),
      `${expectedConfirmation} `,
      `DAG WRITERS DRAINED: another-hold`,
    ]) {
      expect(() =>
        evaluateCoordinatedRolloutGuard({
          eventName: 'workflow_dispatch',
          holdId: ACTIVE_HOLD,
          manualConfirmation,
        }),
      ).toThrow('COORDINATED_DAG_WRITER_ROLLOUT_CONFIRMATION_REQUIRED');
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
    expect(output).not.toContain('DAG WRITERS DRAINED');
  });

  it('wires the repository hold through a preflight job before deploy concurrency', () => {
    expect(workflow.env?.ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD).toBe(
      ACTIVE_HOLD,
    );
    expect(Object.keys(workflow.jobs ?? {})).toEqual([
      'rollout-policy',
      'deploy-production',
    ]);

    const policyJob = job('rollout-policy');
    const deployJob = job('deploy-production');
    const guardStep = namedStep(
      'rollout-policy',
      'Enforce coordinated DAG writer rollout policy',
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
      ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD:
        '${{ env.ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD }}',
    });

    expect(deployJob.needs).toBe('rollout-policy');
    expect(deployJob.if).toContain(
      "needs.rollout-policy.outputs.should_deploy == 'true'",
    );
    expect(deployJob.concurrency).toEqual({
      group: 'railway-auto-deploy-production',
      'cancel-in-progress': false,
    });
    expect(deployJob['timeout-minutes']).toBe(60);
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
    expect(policyJob.if).toBe(TRUSTED_PROMOTION_PROVENANCE);
    expect(deployJob.env?.DEPLOY_REF).toBe('${{ github.sha }}');
    expect(deployJob.if).toBe(
      "needs.rollout-policy.outputs.should_deploy == 'true' "
      + `&& (${TRUSTED_PROMOTION_PROVENANCE})`,
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
        ?.dag_writer_rollout_confirmation;
    expect(dispatchInput?.required).toBe(false);
    expect(dispatchInput?.description).toContain(
      buildRolloutConfirmation(ACTIVE_HOLD),
    );

    const deployJob = job('deploy-production');
    expect(deployJob.if).toContain(
      "needs.rollout-policy.outputs.should_deploy == 'true'",
    );

    const deployStepNames = [
      'Verify Railway deploy access',
      'Deploy to Railway',
      'Wait for deployment success',
      'Post-deploy watchdog/budget regression check',
    ];
    for (const stepName of deployStepNames) {
      expect(namedStep('deploy-production', stepName)).toBeDefined();
    }
  });
});

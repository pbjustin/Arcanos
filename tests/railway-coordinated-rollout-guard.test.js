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
      'cancel-in-progress': true,
    });
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

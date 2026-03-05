/**
 * Self-Improve Controller
 *
 * Enterprise-style: observe -> evaluate -> decide -> (actuate) with explicit boundaries.
 *
 * This controller wires the existing AI reflections service into an executable decision path.
 */
import { v4 as uuidv4 } from "uuid";
import { loadLoopContract } from "@services/governance/loopContract.js";
import { writeEvidencePack } from "@services/governance/evidencePack.js";
import { isSelfImproveFrozen, freezeSelfImprove } from "@services/incidentResponse/killSwitch.js";
import { metric } from "@services/telemetry/selfImproveMetrics.js";
import { evaluateDrift, logDriftSignal, DriftSignal } from "@services/selfImprove/driftWatcher.js";
import { getAutonomyLevel, canProposePatches } from "@services/selfImprove/autonomy.js";
import { createImprovementQueue, generateComponentReflection } from "@services/ai-reflections.js";
import { generatePatchProposal, type PatchProposal } from "@services/selfImprove/patchProposal.js";
import { gatherRepoContext } from "@services/selfImprove/repoContext.js";
import PRAssistant from "@services/prAssistant.js";
import { createPullRequestFromPatch } from "@services/git.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

export interface SelfImproveTrigger {
  trigger: 'manual' | 'self_test' | 'clear' | 'incident';
  component?: string;
  clearOverall?: number;
  clearMin?: number;
  selfTestFailed?: boolean;
  selfTestFailureCount?: number;
  context?: Record<string, unknown>;
}

export interface SelfImproveDecision {
  id: string;
  autonomyLevel: number;
  frozen: boolean;
  drift: DriftSignal;
  decision: 'NOOP' | 'PATCH_PROPOSAL' | 'ESCALATE' | 'ROLLBACK';
  evidencePath: string;
  reflectionIds?: string[];
  notes?: string;
}

export async function runSelfImproveCycle(input: SelfImproveTrigger): Promise<SelfImproveDecision> {
  const cfg = getConfig();
  const contract = loadLoopContract();
  const id = uuidv4();
  const errors: Array<{ stage: string; message: string; detail?: unknown }> = [];

  const drift = evaluateDrift({
    clearOverall: input.clearOverall,
    clearMin: input.clearMin,
    selfTestFailed: input.selfTestFailed,
    selfTestFailureCount: input.selfTestFailureCount
  });
  logDriftSignal(drift);

  const autonomyLevel = getAutonomyLevel();
  const frozen = isSelfImproveFrozen();

  // Decide
  let decision: SelfImproveDecision['decision'] = 'NOOP';
  let notes = '';

  if (frozen || cfg.selfImproveEnabled === false) {
    metric('self_improve.frozen', { id, reason: frozen ? 'kill_switch' : 'disabled' });
    decision = 'NOOP';
    notes = frozen ? 'Frozen by kill switch' : 'Disabled by config';
  } else if (drift.kind !== 'none') {
    metric('self_improve.triggered', { id, trigger: input.trigger, drift: drift.kind, severity: drift.severity });
    // High severity drift => rollback posture (freeze + escalate)
    if (drift.severity === 'high') {
      freezeSelfImprove(`High severity drift: ${drift.kind}`);
      decision = 'ROLLBACK';
      notes = 'High severity drift: system frozen and rollback posture activated';
    } else {
      decision = canProposePatches() ? 'PATCH_PROPOSAL' : 'ESCALATE';
      notes = decision === 'PATCH_PROPOSAL' ? 'Proposing improvements based on drift' : 'Autonomy too low; escalation required';
    }
  } else {
    decision = input.trigger === 'manual' ? (canProposePatches() ? 'PATCH_PROPOSAL' : 'ESCALATE') : 'NOOP';
    notes = decision === 'NOOP' ? 'No drift signal' : 'Manual run';
  }

  // Actuate (proposal + optional PR-bot actuator)
  const reflectionIds: string[] = [];
  let patchProposal: PatchProposal | undefined;
  let prResult: { success: boolean; message: string; branch?: string; commitHash?: string; error?: string } | undefined;
  if (decision === 'PATCH_PROPOSAL') {
    // Create a small queue: prioritize high then medium.
    // If a component is provided, also generate a component-scoped reflection.
    const queue = await createImprovementQueue(['high', 'medium'], {
      category: input.component ? `component-${input.component}` : 'system',
      useMemory: true
    });

    for (const [index, item] of queue.entries()) {
      //audit Assumption: reflection persistence is best-effort and may not return DB ids; risk: non-stable identifiers; invariant: evidence contains traceable reflection references; handling: generate deterministic local ids.
      const generatedAt = item.metadata?.generated ?? new Date().toISOString();
      reflectionIds.push(`queue-${index}-${generatedAt}`);
    }

    if (input.component) {
      const comp = await generateComponentReflection(input.component, { priority: 'high', useMemory: true });
      //audit Assumption: component reflection may not expose storage id; risk: weaker cross-linking; invariant: component reflection remains attributable in evidence; handling: synthesize component-scoped reference id.
      const generatedAt = comp.metadata?.generated ?? new Date().toISOString();
      reflectionIds.push(`component-${input.component}-${generatedAt}`);
    }

    metric('self_improve.patch_proposal', { id, count: reflectionIds.length, component: input.component });
    // Generate a structured patch proposal (diff + commands) and optionally open a PR (PR-bot mode).
    try {
            // Repo-context grounding: gather lightweight snippets to help the model propose a correct diff.
      const repoContext = await gatherRepoContext({
        keywords: [
          input.trigger,
          input.component || "",
          drift.kind,
          "CLEAR",
          "trinity",
          "runClearAudit",
          "selfImprove",
          "PRAssistant",
          "evidencePack"
        ],
        workingDir: process.cwd()
      }).catch(() => null);

      const proposalContext = {
        ...(input.context || {}),
        repoContext: repoContext ? { summary: repoContext.summary, snippets: repoContext.snippets } : undefined
      };

      patchProposal = await generatePatchProposal({
        trigger: input.trigger,
        component: input.component,
        clearOverall: input.clearOverall,
        clearMin: input.clearMin,
        context: proposalContext,
        prohibitedPaths: contract.prohibitedPaths
      });

      metric('self_improve.patch_structured', { id, risk: patchProposal.risk, files: patchProposal.files.length });

      // Deterministic gating: run PRAssistant before proposing a PR.
      const assistant = new PRAssistant();
      const analysis = await assistant.analyzePR(patchProposal.diff, patchProposal.files);

      //audit Assumption: conditional PR analysis can still be safe for human-reviewed PR creation; risk: weaker automated gate strictness; invariant: hard-fail status remains blocked; handling: allow ✅ and ⚠️, block ❌.
      const gatesOk = analysis.status === '✅' || analysis.status === '⚠️';
      metric('self_improve.pr_gate', { id, ok: gatesOk, status: analysis.status });

      if (gatesOk && cfg.selfImproveActuatorMode === 'pr_bot') {
        const title = `[Self-Improve] ${patchProposal.summary}`.slice(0, 120);
        const body = [
          `Goal: ${patchProposal.goal}`,
          `Risk: ${patchProposal.risk}`,
          '',
          'Success metrics:',
          ...(patchProposal.successMetrics?.map(m => `- ${m}`) ?? []),
          '',
          'Validation commands:',
          ...(patchProposal.commands?.map(c => `- ${c}`) ?? []),
          '',
          'Evidence:',
          `- Self-improve cycle id: ${id}`,
          `- Drift: ${drift.kind} (${drift.severity})`
        ].join('\n');

        prResult = await createPullRequestFromPatch({
          title,
          body,
          diff: patchProposal.diff,
          base: 'main',
          labels: ['self-improve', `autonomy-${cfg.selfImproveAutonomyLevel}`, (cfg.selfImproveAutonomyLevel >= 2 ? 'requires-human-approval' : 'propose-only')]
        });

        metric('self_improve.pr_created', { id, success: prResult.success, branch: prResult.branch });
      } else if (!gatesOk) {
        // If gates fail, do not open PR; keep proposal + analysis in evidence pack.
        notes += ` | PR gates failed: ${analysis.summary}`;
      }
    } catch (e: unknown) {
      metric('self_improve.patch_structured_error', { id });
      errors.push({ stage: 'patch_proposal_or_pr', message: resolveErrorMessage(e), detail: { trigger: input.trigger, component: input.component } });
      notes += ` | Structured patch proposal failed: ${resolveErrorMessage(e)}`;
    }

  } else if (decision === 'ESCALATE') {
    metric('self_improve.escalate', { id, drift: drift.kind });
  } else if (decision === 'ROLLBACK') {
    metric('self_improve.rollback', { id, drift: drift.kind });
  } else {
    metric('self_improve.noop', { id });
  }

  // Evidence pack
  const evidencePath = await writeEvidencePack({
    id,
    createdAt: new Date().toISOString(),
    environment: cfg.selfImproveEnvironment,
    autonomyLevel,
    decision,
    trigger: input.trigger,
    context: {
      input,
      contractVersion: contract.version,
    },
    evaluator: {
      drift,
      contract: {
        prohibitedPaths: contract.prohibitedPaths,
        rollback: contract.rollback,
      }
    },
    actions: {
      reflectionIds,
      patchProposal,
      prResult
    },
    errors,
    rollback: decision === 'ROLLBACK' ? { frozen: true, reason: notes } : undefined
  });

  return {
    id,
    autonomyLevel,
    frozen,
    drift,
    decision,
    evidencePath,
    reflectionIds,
    notes
  };
}

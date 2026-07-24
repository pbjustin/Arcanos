# Governance

This folder contains human-readable governance artifacts for ARCANOS self-improving loops.

`../contracts/loop_contract.v1.json` is the machine-readable policy contract used at runtime. The guidance below explains the human operating requirements but does not replace that contract.

## Versioning and release evidence

Version prompts, routing rules, thresholds, tool permissions, controllers, evaluators, and loop contracts in git. Every self-improve cycle must record:

- the before and after git SHAs when a change is made;
- the environment and autonomy level;
- the decision output and evaluator results, including PRAssistant, CLEAR, and self-tests; and
- the rollback plan and, when triggered, rollback result.

Autonomy Level 2 or higher requires a staged rollout: validate a staging canary first, then promote to production with an evidence pack.

## Rollback rules

Rollback is triggered when the post-change healthcheck or self-test pipeline fails, or when the CLEAR score falls below the configured minimum. Revert the latest soft configuration or prompt change when applicable, freeze self-improvement at Autonomy Level 0, and escalate to human review.

Each rollback evidence pack must record the trigger, decision, applied changes, verification results, and rollback outcome. Evidence packs belong under `evidence_packs/`; that directory may be absent until the first pack is generated. Retention and other machine-enforced settings remain defined by `../contracts/loop_contract.v1.json`.

## Branch protection and human approval

`.github/workflows/require-approval.yml` fails its `require-approval` job when a pull request has the `requires-human-approval`, `autonomy-2`, or `autonomy-3` label but lacks an approved review from someone other than the pull-request author. Self-improve pull requests use `self-improve`, `autonomy-<n>`, and either `requires-human-approval` for Level 2 or higher or `propose-only`.

Protect `main` in GitHub with:

1. pull requests required before merging;
2. at least one approving review; and
3. required status checks for the `build-test` job from the `PR CI` workflow and the `require-approval` job from the `Require Human Approval (Self-Improve)` workflow.

Optionally require Code Owner review. To establish ownership, copy `templates/CODEOWNERS.example` to `.github/CODEOWNERS` and replace its placeholder handles. The approval workflow is label-driven, so the same gate can be applied to another pull request by adding a covered label.

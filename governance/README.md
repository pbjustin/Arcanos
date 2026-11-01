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

The label-based policy in [require-approval.yml](../.github/workflows/require-approval.yml)
requires an approving review of the current pull-request head from a human with
repository write, maintain, or admin access other than the author when a PR has
`requires-human-approval`, `autonomy-2`, or `autonomy-3`. Bot reviews, stale
approvals, dismissed reviews, and changes-requested reviews do not satisfy it.
Self-improve pull requests use `self-improve`, `autonomy-<n>`, and either
`requires-human-approval` for Level 2 or higher or `propose-only`.

Labels are mutable and unlabeled pull requests skip this workflow's approval
requirement. Its `pull_request_target` run uses trusted base-branch workflow
code without checking out or executing PR code; its result is not a replacement
for GitHub's native required-review enforcement on the PR head.

A read-only GitHub inspection on 2026-11-01 verified that `main` is protected and
lists `docs:check` (Documentation Audit) and `All Checks Complete` (CI/CD Pipeline)
as required status contexts, associated with the GitHub Actions app (15368).
The limited branch response reports `enforcement_level: non_admins` for these
checks. Repository and applicable-branch ruleset endpoints returned empty lists.
The full branch-protection endpoint was inaccessible (HTTP 403); required review
counts, stale-review dismissal, Code Owner review, bypasses, and administrator
enforcement are **UNVERIFIED**. `build-test` and `require-approval` must not be
described as configured required checks without current GitHub evidence.

Maintain the policy of independent review for covered self-improve changes.
Repository administrators should verify native protection requires pull requests,
at least one independent approving review, dismissal of stale approvals, the
existing required checks, and administrator enforcement as appropriate. This
recommendation does not change GitHub settings. A sole maintainer cannot supply
an independent approval on their own pull request; appoint an authorized second
reviewer where that policy applies.

The active [CODEOWNERS](../.github/CODEOWNERS) routes repository, documentation,
daemon, and workflow changes to `@pbjustin`; routing alone does not enforce
review. Keep advisory AI analysis and CodeRabbit findings separate from required
CI and human approval. Neither authorizes a merge or production promotion.

## Dependency and security settings

[Dependabot](../.github/dependabot.yml) proposes grouped weekly updates for npm
workspaces (including the standalone runtime), the Python daemon, and GitHub Actions.
It does not merge or deploy updates and does not replace the existing dependency
policy checks.

GitHub secret scanning, push protection, and CodeQL activation are **UNVERIFIED**
from the available API responses. Administrators should inspect these settings
and enable the appropriate built-in protections without adding duplicate scans.

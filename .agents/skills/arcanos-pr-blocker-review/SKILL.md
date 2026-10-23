---
name: arcanos-pr-blocker-review
description: Review an ARCANOS GitHub pull request for code blockers, failing checks, unresolved review threads, or merge readiness. Use for requests such as review this PR or find blockers; a review alone does not authorize repairs or publication.
---

# ARCANOS PR blocker review

Produce a blocker-focused verdict tied to the current remote PR head and base. Apply this workflow to ARCANOS checkouts, including isolated worktrees; resolve the repository from the task rather than assuming a fixed local path.

## Establish the review scope

- Read the target checkout's `AGENTS.md` and applicable tracked policy. Prefer current configuration, source, tests, and CI over historical notes.
- Carry forward the user's existing authorization. A review request permits inspection and appropriate local validation, but does not by itself authorize repairs, dependency installation, commits, pushes, labels, review publication, merge, preview deployment, or cleanup. When a combined review-and-fix task already authorizes an action, continue within that scope without asking again.
- Record checkout root, branch, HEAD, dirty state, and worktree ownership before local work. Preserve existing modifications. Use remote file/diff reads or a clean isolated worktree at the PR head when the shared checkout is dirty, unrelated, or at another revision.

## Collect current evidence

1. Resolve the PR number and repository from the user's request or current branch. Use `gh pr view` for head/base OIDs, branches, open/draft state, mergeability, merge state, and check rollup; use `gh pr checks` for check details. These fields do not include all review-thread state: retrieve and paginate review threads through GitHub GraphQL or an available connector. Never equate an approval summary with zero unresolved threads.
2. Inspect applicable branch protection or rulesets when accessible. Evaluate the checks and approvals actually required for this PR. In current ARCANOS workflows, `docs:check` and `All Checks Complete` are relevant signals; refresh names and requirements rather than freezing this list. Missing access means unknown, not satisfied.
3. Where useful, split independent read-only tracks across agents: patch/contracts/tests, CI/review state, and runtime/deployment risks. Give each the same head/base and no mutation authority beyond the current task.
4. Inspect the exact diff and affected consumers/tests. Check protocol and ActionPlan boundaries against `AGENTS.md`. Focus findings on demonstrated regressions, contract violations, and missing tests that leave a concrete risk unverified. Give file/line and triggering conditions for each blocker.
5. Trace failed checks to exact run/job logs. Distinguish code failures from environment failures, intentional skips, and approval-gated zero-job runs. For workflow permissions, inspect both scalar and mapped YAML forms. If green visible checks coexist with `UNSTABLE`, inspect check suites and `action_required` runs or explicitly leave the cause unresolved.
6. Choose local checks from the canonical [validation matrix](../../../CONTRIBUTING.md#required-local-validation). Verify the required toolchain and dependencies first; do not describe a focused harness as a canonical build. A stale generated index may call for `npm run reindex` plus `npm run reindex:check` in an authorized repair, not automatic regeneration during a read-only review.

## Evidence boundaries and failures

- A sealed Railway preview establishes only the exact served component and isolation behavior exercised by its verifier. It does not establish live PostgreSQL, queue, worker loop, Notion, model-provider, or production behavior.
- If a Windows CI-inspector helper fails on encoding or response shape, use bounded `gh pr checks`, `gh run view`, or job-log API reads. Do not classify a helper crash as a PR regression.
- Authentication or log-access failures do not authorize credential changes. Report the unavailable evidence and continue independent inspection. Keep raw credentials and sensitive logs out of output.
- Do not restart services, initialize databases, run workers, call memory/dispatch endpoints, or invoke live probes as review validation.
- Give every blocker its basis: a demonstrated defect, an applicable required check/review, an explicit task acceptance condition, consequential unresolved evidence, or missing authorization for a specific necessary action. Cite the evidence or requirement and its effect on the verdict.
- Distinguish a failed requirement, an unverified requirement, an optional check not run, and a reported risk/limitation. Optional validation does not create a merge gate; required gates remain binding even when code appears sound. Do not require Codex Cloud, CodeRabbit, full suites, previews, or live acceptance unless current policy or the task requires them.

## Future explicitly authorized merges

This section documents merge mechanics; review or readiness alone never grants merge authorization.

1. Refresh the current remote PR head/base, applicable checks, required reviews, unresolved threads, and lifecycle state. Confirm the evidence covers the head being merged and that the authorized action meets the current gates.
2. Submit the reviewed PR head as a **server-enforced expected-head condition**: GitHub's [REST merge endpoint](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request) accepts `sha`; the GitHub connector exposes this as `expected_head_sha`. The supported CLI option is `gh pr merge --match-head-commit <reviewed-head-sha>`; preserve the expected-head condition in the actual merge request.
3. If the head changes or GitHub rejects a mismatch, refresh affected review/check evidence before any authorized retry. Never retry without the expected-head condition or use an administrative bypass to evade the mismatch or required gates.
4. Record the returned merge commit SHA and refresh the resulting default-branch state. Verify the merge commit is on that branch; if the branch has advanced, verify ancestry rather than assuming its tip still equals the merge commit. Report queued/pending actions as pending until a merge and resulting branch state are confirmed.

## Deliver the verdict

Immediately before reporting, refresh remote head/base, required checks, draft/open state, mergeability, labels relevant to lifecycle, and all unresolved threads. A changed head or base invalidates affected earlier evidence; re-evaluate it before declaring readiness.

Lead with blockers or none found, then give exact head/base, review/check state, validation performed, and meaningful limits. Distinguish no code blockers from merge-ready: draft status, required checks/approvals, unresolved threads, or unknown/conflicting merge state can still prevent readiness. Propose the smallest repair for each finding and perform only actions already authorized. Never infer merge or deployment authorization from readiness.

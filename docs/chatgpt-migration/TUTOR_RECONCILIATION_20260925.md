# Tutor migration reconciliation after PR #1513

Later baseline-only follow-up: [owner-approved published-version capture](TUTOR_BASELINE_CAPTURE_20260925.md).
The published baseline is now VERIFIED. The reconciliation observations below
remain historical; live runtime acceptance and migration remain blocked.

Evidence date: **2026-09-25 UTC**. This record separates repository reconciliation,
provider metadata, historical live acceptance and account migration evidence.
#1509 remains **DRAFT**, auto-merge disabled. **MIGRATION_CHECKPOINT_READY=false**.
No merge of #1509, deployment, GPT migration, account change or new live call is
part of this task.

## Current main and runtime

- Main merged: `71672aec22d7babf62d65b96de667f17abd3f219`.
- Prior #1509 head preserved: `68bd5eeebf63f637ccd743110d81da5cce1b1991`.
- Existing branch: `codex/arcanos-tutor-plugin-finalization`.
- Non-destructive merge; no rebase, squash, force-push or migration history loss.
- Conflicts: `backend-index.json` and `docs/BACKEND_INDEX.md` only. Regenerating all
  four indexes proved their content equal to main except generation timestamps.
  Main's exact generated files were retained; `reindex:check` passed.
- No remaining differences in runtime source, protocol schemas, runtime tests,
  preview fixtures/verifiers/workflows or production runtime/deployment docs.
  Main is authoritative, including Tutor/Trinity honesty and MCP prompt schema.

| Runtime PR | Merged SHA | Evidence scope |
| --- | --- | --- |
| [#1511](https://github.com/pbjustin/Arcanos/pull/1511) | `3f9611c9e59b1283d7aa4e7b9aef57a17841f97f` | Merged/deployed historically; superseded deployment pair removed |
| [#1512](https://github.com/pbjustin/Arcanos/pull/1512) | `331a9676f3c6edf9463b6fb6ddd3f1ce6bb07ed1` | Merged/deployed historically; superseded deployment pair removed |
| [#1513](https://github.com/pbjustin/Arcanos/pull/1513) | `71672aec22d7babf62d65b96de667f17abd3f219` | Sealed honesty-composition verification; not a runtime behavior fix or live acceptance |

At **2026-09-25T15:11:15Z**, independent read-only Railway `get_status` and
`list_deployments` observations confirmed current latest worker
`e08d2468-a287-4d5c-aa1b-f3b8aaf7d0b2` and web
`a994758c-bc6a-4d4e-a8dc-fd4e66cb5f1e`, both **SUCCESS**. Both provider metadata
records identify current main's exact SHA. This is provider metadata, not
independent container attestation, fresh readiness or provider execution proof.
No settings, credentials, staged changes or deployment state were modified.

## Current live acceptance

**RUNTIME_ACCEPTANCE=FAIL; LIVE_TUTOR_CALL_VERIFIED=BLOCKED.** The latest recorded
live checkpoint is the post-#1512 result published in #1509 and corroborated by
#1513. Six bounded A/C/D attempts were preserved, without retries:

- Raw A failed authentication before execution; existing Primary recovery succeeded.
- Raw C omitted the required learner cross-multiplication instruction and included
  a neutral qualification.
- Raw D preserved three numbered lines but added an unwanted qualifying introduction.
- ChatGPT A reported missing link_id; C/D displayed noncompliant answers.
- Same-invocation raw ChatGPT payloads were unavailable; no backend/wrapper
  attribution is inferred. A supplies no formatting evidence.

No newer passing live evidence was found. #1513's sealed synthetic verification
cannot clear this blocker. The earlier post-#1510 measurements remain in
[Tutor runtime acceptance](TUTOR_RUNTIME_ACCEPTANCE.md) as dated history.
Existing connection, OAuth recovery and discovery remain verified in their dated
evidence domain. Exact-client refresh-token renewal durability and expiry cause
remain unverified/unknown. No Auth0, OAuth or connection change was performed.

## Published GPT baseline

**GPT_BASELINE_CAPTURED=BLOCKED.** Read-only inspection was restricted to
`.local-migration/arcanos-tutor/` in the existing branch and prior review worktrees.
The branch input directory is absent. The prior review directory has 22 historical
runtime/provisional-observation files and no `published-gpt.json`. No complete
published baseline exists, so capture was not run and no sanitized inventory was
manufactured. Private files remained in their existing ignored location.

The owner must supply the actual latest published configuration using
[TUTOR_INPUTS.md](TUTOR_INPUTS.md): `schemaVersion: 1`, exact display name,
complete description and Builder instructions, exact conversation starters,
enabled capabilities, every Action name and complete non-secret schema, sharing
status, published version label and exact timestamp, and nonempty representative
expected-behavior descriptions. Also required: the complete knowledge inventory
and original files at relative local paths, plus owner/account evidence that the
configuration is the latest published version. Unknown inventory is not zero
files. Empty lists require explicit confirmation that there are none.

Publication review must record reviewer, review date,
`latestPublishedConfirmed: true` and supporting evidence IDs. Raw exports,
instructions, schemas containing private content, original knowledge files and
transcripts stay solely under `.local-migration/arcanos-tutor/`; only reviewed
safe metadata/hashes/summaries can enter tracked inventories.

## Migration artifacts and parity

No migration has occurred. The package skill is a repository integration candidate;
actual migrated skill, metadata, app mapping and references are absent. Reference
publication approval remains empty. No migrated-plugin result was generated.

Parity: **16 total; 0 official baseline-bound old-GPT cases; 10 provisional/unbound;
6 unexecuted**. All official `oldGpt` and `plugin` fields remain null and all rows
remain `BLOCKER`. The 16 prompt hashes and 10 available sanitized-summary hashes
were independently recomputed and match; that verifies metadata integrity, not
published-configuration identity or case success.

Unexecuted: `unsupported-admin`, `auth-failure`, `backend-unavailable`, `timeout`,
`cancellation`, and `reference-use`. Historical observations were not promoted.

## Gate ledger

| Gate | Status |
| --- | --- |
| CODE_READY | VERIFIED — repository migration/package scope |
| BACKEND_DEPLOYED | VERIFIED — exact current pair, provider metadata |
| OAUTH_CONFIGURED | VERIFIED — dated recovery evidence; durability unverified |
| CHATGPT_CONNECTION_REGISTERED | VERIFIED — existing dated evidence |
| TOOL_DISCOVERY_VERIFIED | VERIFIED — existing dated evidence |
| LIVE_TUTOR_CALL_VERIFIED | BLOCKED |
| GPT_BASELINE_CAPTURED | BLOCKED |
| GPT_MIGRATED | NOT_STARTED |
| SKILL_RECONCILED | BLOCKED |
| REFERENCES_RECONCILED | BLOCKED |
| PARITY_VERIFIED | BLOCKED |
| PACKAGE_READY | BLOCKED |
| RELEASE_READY | BLOCKED |

## Remaining diff and validation

The remaining diff is migration/package-specific: standalone package and metadata,
retirement of the repository pilot template, capture/release tools and their
regressions, private-input ignore/commit guards, npm entry points, and migration
handoff/evidence documents. No runtime source file remains in the diff.
Migration/package tests remain intentionally present. Validators are unchanged.

Local validation used exact Node **24.18.1** / npm **11.16.0**:

| Check | Result |
| --- | --- |
| type-check / build | PASS, including source and emitted preview import boundaries |
| lint | PASS; 0 errors, 76 existing warnings |
| Focused Jest | PASS; 6 suites, 217 tests, 0 failed/skipped |
| validate:tutor-package | PASS; three candidate files, no archive |
| validate:tutor-release | Expected exit 2 / RELEASE_BLOCKED; 14 blocker codes, no archive |
| docs:check | PASS; 751 checks, 0 failed/warnings |
| docs:links -- --local-only | PASS; 552 local targets, 0 failed; external network checks skipped |
| reindex / reindex:check | Regenerated all four, retained exact-main versions; check PASS |
| sync:check | PASS; 0 errors/warnings, 5 informational notices |
| guard:commit / git diff --check | PASS; staged private-input path count 0 |

The focused selection covers package/release boundaries, legacy migration routing,
private commit guards, instructional verification, Tutor pipeline and synthetic
preview fixture tests. Mocked/offline results are not live Tutor acceptance.
Package fingerprint is
`68d3f50349eaf9fd0d6bea89a6c725b13ca8e0b6ede937e556702902e98a5b39`.
Hosted CI belongs to the final pushed head and is recorded separately in the
[PR body](https://github.com/pbjustin/Arcanos/pull/1509); earlier CI is historical.

## Independent review and owner checkpoint

Independent review found **no in-scope blocker** after checking runtime equality,
no #1511/#1512/#1513 reversion, migration-only scope, absence of staged private
data, evidence-consistent gates, synthetic/live separation and absence of
migration-complete claims. It corroborated the failed checkpoint in both PR bodies.
The dated connection wording was clarified; see the
[independent review record](TUTOR_INDEPENDENT_REVIEW.md).

Baseline collection **may continue**. Stop at the missing published baseline.
Even a completed baseline would not clear failed runtime acceptance. Migrate to
plugin remains **not authorized** and requires separate explicit owner confirmation
after actual blockers clear. Keep #1509 draft; no automatic ready, merge or release.

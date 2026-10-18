# PR #1557 complexity review

Review baseline: `0d462afe7f65414c60c99f86ea62de39c8a81a20`; base/main:
`4b961a0df8a700340dcf795a7f41223685211a31`. Earlier core repair:
`3ff4e3a5d49f4dde8d041ec25668683763e1128b`.

The baseline diff contains 58 files, 7,267 additions and 503 deletions. Tests
account for 4,393 additions; production source accounts for 1,210. Changes after
the core repair account for 4,127 additions and 162 deletions, including genuine
production corrections for fresh pending work, stale worker rows and stale
provider evidence. That entire interval is not disposable acceptance machinery.

## Component decisions

| Component | Classification | Decision and protected behavior |
| --- | --- | --- |
| Worker control/autonomy backlog, heartbeat and fleet classification | ESSENTIAL | Retain. Idle and running-only queues remain healthy; aged pending, stalled jobs, unavailable workers and current failures remain actionable. |
| Predictive evidence, explicit inference intent and separate repair authorization | ESSENTIAL | Retain. Fresh actionable evidence and authorization precede admission; disabled automation and simulations cannot spend inference. |
| Provider-health timestamp merging | SIMPLIFIABLE | Reuse already captured health in state updates. Retain fresh reads after asynchronous admission and success normalization, including conservative same-millisecond failure handling. |
| Predictive worker-inactivity explanation branches | SIMPLIFIABLE | Remove unreachable no-backlog alternatives: inactivity degradation already requires blocked backlog. Detection and returned worker identities remain equivalent. |
| Redis inference coordinator and lifecycle operation gates | ESSENTIAL | Retain unchanged from the core repair. Shared purpose ledgers, atomic sibling rejection checks, Redis time, cooldowns, rolling budgets, bounded CAS retries and non-expiring uncertain holds cannot become process-local state. |
| Bounded inference client | ESSENTIAL | Retain unchanged from the core repair. One non-streaming Core request, zero SDK retries, token/time caps and synchronous closure preserve accounting, routing and fine-tuned models. |
| Provider authentication fingerprint and reload suppression | JUSTIFIED | Retain. The local provider latch and durable cross-process rejection ledger cover different entry paths; neither replaces the other. |
| Loop rules-first integration and diagnosis telemetry distinctions | ESSENTIAL | Retain. Deterministic healing continues during inference denial; evaluation is not reported as paid inference or permission to repair. |
| Process-local telemetry emission subscription | JUSTIFIED | Retain. Hydrated history and ring eviction cannot prove current emissions; sequence gaps invalidate preview evidence. No listener is installed by ordinary production startup. |
| Preview inference profile, startup/shutdown, Docker and import guards | VALIDATION-ONLY | Retain extensions of the existing supervisor and artifact attestation; they preserve credential isolation, exact source, eight-worker bounds and orderly drainage. |
| Preview containment controls and ledger inspection | VALIDATION-ONLY | Retain closed operations and sanitized observations. Remove the unused diagnostic Redis TIME result; bounded GET/PTTL for both ledgers remain atomic. Production admission still uses Redis time. |
| Synthetic OpenAI fixture extensions | JUSTIFIED | Retain in the existing fixture. Credential rejection, cancellation and upstream work continuing after disconnect protect distinct failure cases. |
| Inference acceptance runner and regression tests | VALIDATION-ONLY | Retain pending evidence completion. Reuses existing receipt validation, publication, sanitization, SSH transport, restart and ownership checks; it does not introduce a second deployment lifecycle. |
| Existing acceptance transport/profile/job extensions | JUSTIFIED | Retain closed role-specific vocabulary and ownership checks. Arbitrary commands, worker identities and production credentials remain excluded. |
| Cleanup ownership registry and pending-volume handling | JUSTIFIED | Retain. Mixed-PR resources and deletion-retention states require explicit ownership and absence evidence. |
| Core routing, security, telemetry and admission regression tests | JUSTIFIED | Keep original cost-runaway assertions and distinct failure-path coverage. Test size alone is not a removal criterion. |
| Configuration/API/recovery documentation and generated indexes | JUSTIFIED | Keep contracts synchronized. Provide a one-shot operator recipe using the existing completion function; add no recovery service or automatic expiry. |

No whole component was found to be DUPLICATIVE. The unused preview clock fields
were UNNECESSARY. Similar health checks at separate authorization, observation
and transport boundaries must not be collapsed merely because their predicates
look alike. A new framework or shared health state machine would add more scope
than these surgical changes justify.

## Acceptance scope and retention

Mandatory hosted acceptance remains four behavior groups:

| Group | Existing cases and evidence requirement |
| --- | --- |
| A: healthy idle | `idle_off`, `idle_on`: eight workers, twenty evaluations per mode, zero requests, false degradation and repairs. |
| B: running only | `running_on`: one legitimate running job, other workers idle, no stalled/pending work, no false repair, normal completion. |
| C: genuine incident | `diagnosis_once`: fresh real fault, disabled-intent denial, one authorized bounded synthetic request, overlapping Worker/V2 denial and no unauthorized repair. |
| D: failure/recovery | `probe_rotation`, `uncertain_restart`: rejection/cooldown, durable reservation and restart, authorized reconciliation and no premature admission. Redis coordination-unavailable hosted evidence is still required if not independently retained. |

`running_off`, `metadata_recovery` and `late_completion` remain extended tests of
feature-mode behavior, timestamp freshness and work continuing after disconnect.
They are not additional top-level acceptance groups. The inference runner does
not currently exercise Redis unavailability: a transport capable of restarting
Redis and older coordinator scenarios do not establish this inference guarantee.
Local fail-closed regressions remain necessary but are not hosted proof.

Permanent infrastructure should remain the existing lifecycle, supervisor,
transport, synthetic provider, ownership controls and behavior-focused tests.
Keep PR-specific runner/commands until the exact-source receipts and cleanup
evidence are collected. Any later retirement must preserve those receipts,
their verifier revision, equivalent regression coverage and resource ownership;
do not delete them during incomplete acceptance. No separate PR is created or
required by this review. A future removal can narrowly remove the PR1557 runner,
its containment-only commands and scenario wiring after these dependencies end.

## Operational and evidence boundaries

Uncertain paid work has no safe automatic expiry. Operators must prove terminal
upstream state and use the existing token/scope-bound completion transition;
cooldown, attempt-budget and rejected-credential history must survive. The
maintained [recovery runbook](../../../PREDICTIVE_SELF_HEALING.md#reconciling-an-abandoned-reservation)
owns the executable procedure. Deterministic healing remains available during
the hold. No new recovery control plane is warranted.

At the read-only Railway inventory on 2026-10-18, the seven retained PR1557
projects (`p17a/b/c/d/f/i/j`) contained no active services, deployments, volumes,
buckets or pending operations exposed by the inventory APIs. Project/environment
scopes remain. This does not supersede earlier deletion-retention receipts or
claim physical erasure. Main Arcanos had no PR1557 environment. Existing unrelated
live validation and staged preview-base work were preserved. Worker/V2 remained
at the base SHA. No production operation, key change, real paid inference,
merge, auto-merge or evidence deletion was performed.

Baseline CI was still running when inspected and was neither canceled nor
rerun. Thirteen baseline review threads were resolved. Previous hosted results
remain historical after these source changes; neither green local tests nor
native sealed-preview checks establish active-worker acceptance at the final
head. Final commit, CI/review results and validation counts are recorded on the
existing PR, rather than treated as immutable facts in this source report.

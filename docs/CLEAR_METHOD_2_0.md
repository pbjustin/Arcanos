# CLEAR Method 2.0

## Overview
CLEAR Method 2.0 is Arcanos' governance-scoring framework for plan safety and operational quality. It evaluates plans across five principles and produces a deterministic decision (`allow`, `confirm`, or `block`) that downstream routes can enforce. The implementation is centered on `src/services/clear2.ts` and is consumed by plan creation, plan execution rechecks, and dedicated CLEAR endpoints.【F:src/services/clear2.ts†L1-L248】【F:src/routes/plans.ts†L1-L295】【F:src/routes/clear.ts†L1-L71】

The five CLEAR dimensions are:
- **C — Clarity**
- **L — Leverage**
- **E — Efficiency**
- **A — Alignment**
- **R — Resilience**【F:src/services/clear2.ts†L1-L12】

## Scoring Model

### 1) Principle scoring
`computeClear2PrincipleScores` calculates each principle score from plan signals (action structure, confidence, rollback presence, capability/agent context), then clamps scores to `[0,1]`.【F:src/services/clear2.ts†L152-L208】

### 2) Composite score
`computeClear2CompositeScore` applies normalized weights to principle scores and returns a rounded composite score (3 decimal places).【F:src/services/clear2.ts†L82-L102】

Default weights:
- clarity: `0.25`
- leverage: `0.15`
- efficiency: `0.20`
- alignment: `0.20`
- resilience: `0.20`【F:src/services/clear2.ts†L49-L55】

### 3) Decision thresholds
`evaluateClear2Decision` maps composite score to decision:
- `overall >= 0.70` → `allow`
- `0.40 <= overall < 0.70` → `confirm`
- `overall < 0.40` → `block`【F:src/services/clear2.ts†L7-L12】【F:src/services/clear2.ts†L104-L115】

## How CLEAR 2.0 is used for auditing

There are two related auditing paths in Arcanos:

1. **Plan governance auditing (CLEAR 2.0)**
   - CLEAR 2.0 results are attached to each ActionPlan at creation time.
   - Decision and score are persisted and logged, making plan lifecycle transitions auditable (`planned`, `awaiting_confirmation`, `approved`, `blocked`, etc.).【F:src/stores/actionPlanStore.ts†L57-L118】【F:src/stores/actionPlanStore.ts†L144-L181】

2. **Feedback auditing (`/audit`) with CLEAR scorecards**
   - The reinforcement audit endpoint (`POST /audit`) validates inbound payloads, normalizes score scales, creates an audit record, and attempts external delivery.
   - This path uses scorecard-style CLEAR payload parsing (`scores`, composite/status) and includes explicit `//audit` annotations for branch assumptions and failure handling.【F:src/routes/reinforcement.ts†L36-L55】【F:src/services/audit.ts†L1-L266】【F:src/services/clearScorecard.ts†L1-L210】

In short: CLEAR 2.0 governs **execution gating** for plans, while `/audit` governs **feedback ingestion and traceability** for reinforcement loops.

## How CLEAR 2.0 is used in the codebase

### Route-level usage
- `POST /plans` creates plans and stores CLEAR 2.0 results via store logic.
- `POST /plans/:planId/approve` refuses approval when decision is `block`.
- `POST /plans/:planId/execute` re-runs CLEAR checks before execution and can auto-block if recheck fails.
- `POST /clear/evaluate` evaluates a payload without creating a plan.
- `GET /clear/:planId` fetches a persisted CLEAR score.【F:src/routes/plans.ts†L33-L295】【F:src/routes/clear.ts†L1-L71】

### Store-level usage
- `createPlan` computes CLEAR 2.0, persists the score, and derives initial plan status from decision.
- Status transitions remain constrained by decision (for example, blocked plans cannot be approved).【F:src/stores/actionPlanStore.ts†L57-L118】【F:src/stores/actionPlanStore.ts†L160-L181】

### Mounting and availability
- CLEAR routes are mounted in the global route registry alongside plans and agents routes.
- Feature flags (`enableActionPlans`, `enableClear2`) gate availability in route handlers.【F:src/routes/register.ts†L86-L88】【F:src/routes/plans.ts†L39-L52】【F:src/routes/clear.ts†L24-L30】

## How CLEAR is used in the Trinity pipeline

The Trinity pipeline itself does not call the CLEAR 2.0 scorer directly. Trinity focuses on three-stage AI processing, audit-safe constraints, and telemetry. CLEAR is integrated at the **workflow boundary** where Trinity-produced intent can become ActionPlans and then be policy-gated by CLEAR 2.0 routes/stores.【F:src/core/logic/trinity.ts†L1-L397】【F:src/routes/plans.ts†L33-L295】

Operationally, this separation provides:
- **Reasoning and synthesis in Trinity** (intake → GPT reasoning → finalization).
- **Execution-governance in CLEAR** (score, threshold decision, approval/block enforcement).
- **Audit traceability in reinforcement endpoints** (`/audit`) for post-execution feedback loops.【F:src/core/logic/trinity.ts†L1-L397】【F:src/routes/reinforcement.ts†L36-L55】

## Typical end-to-end flow
1. A client or upstream system generates a plan payload.
2. `POST /plans` stores the plan with a CLEAR 2.0 score and decision.
3. If decision is `confirm`, a human confirmation step can approve it.
4. `POST /plans/:planId/execute` re-validates capabilities and rechecks CLEAR before dispatch.
5. `POST /audit` can later register outcome feedback and forward CLEAR feedback externally for reinforcement analysis.【F:src/routes/plans.ts†L33-L295】【F:src/stores/actionPlanStore.ts†L57-L304】【F:src/routes/reinforcement.ts†L36-L55】

## Related files
- `src/services/clear2.ts`
- `src/routes/clear.ts`
- `src/routes/plans.ts`
- `src/stores/actionPlanStore.ts`
- `src/services/audit.ts`
- `src/services/clearScorecard.ts`
- `src/core/logic/trinity.ts`


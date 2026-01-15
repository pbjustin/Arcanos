# CLEAR 2.0 Operational Guide

This guide explains how CLEAR 2.0 works inside ARCANOS, how scores are evaluated and normalized, and how to integrate scorecards into audit payloads. It also documents the improvements added to support repeatable CLEAR audits and codebase hygiene.

## 1. CLEAR 2.0 Overview

CLEAR 2.0 evaluates orchestration assets across five principles:

- **Clarity** — Trace inputs, decisions, and outputs with metadata.
- **Leverage** — Reuse shared modules instead of duplicating logic.
- **Efficiency** — Meet latency, cost, and resource targets.
- **Alignment** — Ensure decisions match policy and intent.
- **Resilience** — Validate fallback and recovery paths.

Scores are computed on a 0–10 scale, weighted, and combined into a composite score. Composite thresholds gate deployments and patch activations.

## 2. Scorecard Computation

The CLEAR scorecard uses the default weights below:

| Principle | Weight |
|-----------|--------|
| Clarity | 0.25 |
| Leverage | 0.15 |
| Efficiency | 0.20 |
| Alignment | 0.20 |
| Resilience | 0.20 |

The composite score is calculated as the weighted sum of the five principle scores. Thresholds classify the composite score into a status label:

| Status | Threshold |
|--------|-----------|
| Green | ≥ 8.0 |
| Yellow | ≥ 6.0 and < 8.0 |
| Red | < 6.0 |

The runtime scorecard helper (`src/services/clearScorecard.ts`) computes the composite score, applies normalized weights, and returns a status label for auditing and reporting.

## 3. CLEAR Audit Payload Schema

The `/audit` endpoint accepts payloads in one of two shapes:

1. **Composite-only** (backward compatible):

```json
{
  "system": "CLEAR",
  "requestId": "req_123",
  "payload": {
    "CLEAR_score": 8.7,
    "pattern_id": "semantic-guardrail@3.2.0",
    "score_scale": "0-10"
  }
}
```

2. **Scorecard-first** (preferred):

```json
{
  "system": "CLEAR",
  "requestId": "req_123",
  "payload": {
    "scores": {
      "clarity": 8.5,
      "leverage": 7.2,
      "efficiency": 8.1,
      "alignment": 9.0,
      "resilience": 8.9
    },
    "asset": "workflow:narrative-response",
    "revision": "1.18.4",
    "recommendations": [
      "Refactor duplicate summarization logic",
      "Add latency probes to failover worker"
    ]
  }
}
```

If `scores` are supplied, ARCANOS computes the composite score and stores a `clear_scorecard` summary on the audit record payload. If a `CLEAR_score` is also provided, it is used directly to preserve upstream authority.

## 4. Score Scale Normalization

CLEAR score payloads may use a 0–10 or 0–1 scale. The audit service normalizes the score before comparing it to `ARCANOS_CLEAR_MIN_SCORE`:

- If the configured minimum is ≤ 1, scores are normalized to 0–1.
- If the configured minimum is > 1, scores are normalized to 0–10.
- A payload can include `score_scale` (`"0-1"` or `"0-10"`) to override heuristic detection.

The audit record stores:

- `clearScore` (raw score)
- `normalizedClearScore` (score aligned to the configured minimum scale)
- `scoreScale` (declared or inferred scale)

## 5. Audit Records and Contextual Reinforcement

Each CLEAR audit is recorded in the reinforcement window with:

- A summary string including raw score, scale, normalized score, and acceptance result.
- Metadata fields containing `scoreScale` and `normalizedClearScore`.

This ensures audit summaries remain interpretable even when upstream payloads use different scoring scales.

## 6. Recommendations Implemented

The following improvements were added to align the codebase with the documented CLEAR recommendations:

1. **Scorecard Normalization & Validation** — A dedicated scorecard module now normalizes weights, validates scores, computes composite scores, and labels status. (`src/services/clearScorecard.ts`)
2. **Payload Flexibility** — The audit endpoint now accepts either composite scores or full scorecards. (`src/services/audit.ts`)
3. **Scale-aware Gating** — Acceptance gating normalizes scores to match the configured threshold scale. (`src/services/audit.ts`)
4. **Richer Audit Summaries** — Audit records now capture raw and normalized scores with explicit scale metadata. (`src/services/contextualReinforcement.ts`)

## 7. Minimal Test Plan

- **Happy path**: submit a scorecard payload with all five principles and verify `clear_scorecard` is stored and accepted when above threshold.
- **Edge cases**: submit a payload with `CLEAR_score` in 0–1 scale and verify normalization against the configured minimum.
- **Failure modes**: submit a payload missing both `CLEAR_score` and `scores` and verify the endpoint returns a validation error.

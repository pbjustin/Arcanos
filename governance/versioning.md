# Versioning Rules

## What must be versioned
- Prompts, routing rules, thresholds, tool permissions, controllers, evaluators, and loop contracts.

## How
- All changes must be committed in git.
- Every self-improve cycle must record:
  - git SHA (before/after if changed)
  - environment (dev/staging/prod)
  - autonomy level
  - decision output
  - evaluator results (PRAssistant, CLEAR, self-tests)
  - rollback plan / rollback result if triggered

## Release discipline
- Autonomy Level 2+ requires a staged rollout:
  1) staging canary
  2) production promotion with evidence pack

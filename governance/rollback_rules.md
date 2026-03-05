# Rollback Rules

## Automatic rollback triggers
- Healthcheck fails after applying a change
- Self-test pipeline fails after applying a change
- CLEAR score drops below configured minimum

## Rollback actions
- Revert latest soft config/prompt change (if applicable)
- Disable self-improve (freeze) and force Autonomy Level 0
- Escalate to human review with evidence pack attached

## Evidence requirements
- Each rollback must produce an evidence pack that includes:
  - trigger, decision, applied changes, verification results, and rollback outcome

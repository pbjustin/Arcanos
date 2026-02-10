# ARCANOS CLI Execution Contract (v1)

## Authority
- Backend decides intent, policy, confirmations.
- CLI routes, enforces, and degrades trust.
- Local models simulate only; never mutate authoritative state.

## Trust States
- **FULL**: backend reachable, registry fresh.
- **DEGRADED**: backend partial/unavailable or registry stale.
- **UNSAFE**: confirmation-required action while backend unavailable.

## Invariant
- No confirmation-required action may execute outside FULL trust.

# ARCANOS CLI Execution Contract (v1)

This is the Python CLI governance contract. Its trust enum and guard are
`daemon-python/arcanos/cli/trust_state.py:TrustState` and
`daemon-python/arcanos/cli/governance.py:assert_allowed`; state hydration lives
in `daemon-python/arcanos/cli/state.py`. It does not make the TypeScript CLI's
in-memory `exec.start` scaffold a real executor. See
[CLI overview](CLI_OVERVIEW.md) and the
[Local Agent bridge](LOCAL_AGENT_CAPABILITY_BRIDGE.md) for those distinct paths.

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

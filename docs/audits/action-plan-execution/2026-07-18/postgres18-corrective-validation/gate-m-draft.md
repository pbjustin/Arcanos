# Gate M draft — not ready to request

Gate M remains blocked by credential containment, Gate C re-verification, a
real PostgreSQL 18 run of the committed target, Gate V, and the ledger-history
limitation below.

The committed targets are sufficient to execute the planned plan/apply/verify,
runtime verify, disposable-schema CHECK/index probes, drain, and bounded
compatibility operations after their prerequisite gates. The eventual request
must bind the replacement PostgreSQL service, exact source commits, custom
config paths, and canonical migration checksum
`cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533`.

The approved sequence would be: artifact plan; corrected recovery or first
apply; both schema verifiers; all CHECK and index probes; all-22-index
readiness; repeat apply; checksum conflict; advisory-lock contention; drain;
bounded Phase 2D.1 compatibility; and disposable-only compensation. The
primary preview database must never receive compensation.

No Gate M request should be submitted until the ledger-history limitation is
explicitly accepted or a separately approved additive history mechanism exists.
The reviewed migration ledger has one current-state row: recovery overwrites
the failed state, and a later verification failure clears `appliedAt`. Local
tests prove resumable current state, but not durable generic attempt/failure
history.

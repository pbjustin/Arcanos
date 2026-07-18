# Corrective-work rollback

No Railway or database rollback is currently required because no Railway
mutation, validator deployment, migration, credential change, or application
deployment occurred.

Local rollback is commit-scoped:

1. Revert the corrective documentation commit.
2. Revert `9da198f6`, `4c540b44`, and `59088ac8` to remove the bounded validator
   targets and their final hardening.
3. Revert `a31bc7fe` and `83bf5b1e` to remove the verifier and ledger-recovery
   corrections.
4. Revert `c0326dec` only if the historical characterization evidence itself
   must be removed; normally retain it.

The bounded Phase 2D.1 compatibility target is independent on branch
`codex/phase2d1-bounded-compatibility-validator` at commit
`87900e71143781fd9cdea29de23a4763944fa4d9`. Revert the six compatibility
harness commits from `87900e71` through `b6926bcc` independently without
changing the Phase 2D.1 source commit.

After a future approved replacement-service containment, rollback cannot restore
the compromised credential generation. Before old-service retirement, discard a
bad replacement and create another fresh generation. After retirement, create a
new isolated generation; never restore the compromised services or credentials.

After a future approved preview migration, use the reviewed compensation only
when the drain checker proves protocol tables and provenance are empty. Otherwise
disable assignment, leave additive schema in place, and roll back only the
application deployment.

# Backstage Notion partition scope-read index

This additive migration installs the partial parent-page index used by bounded
recursive subtree reads. PostgreSQL requires the concurrent build to run
outside a transaction.

Apply these phases in order, then repeat them to prove idempotence:

1. `01_precheck_parent_page_index.sql`
2. `02_create_parent_page_index.sql` as one standalone non-transactional command
3. `03_verify_parent_page_index.sql`

The precheck and verifier reject a same-name object with any unexpected
catalog property. If the concurrent build is interrupted and leaves the exact
index invalid or not ready, quiesce scope readers, run
`recovery/01_drop_invalid_parent_page_index.sql`, and repeat all phases.

Rollback is not routine recovery. Quiesce scope readers, then run
`rollback/01_drop_parent_page_index.sql`; its catalog guard and ordinary drop
are atomic and the script is idempotent when the index is already absent.

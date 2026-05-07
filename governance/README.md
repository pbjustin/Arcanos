# Governance

This folder contains human-readable governance artifacts for ARCANOS self-improving loops.

- `../contracts/loop_contract.v1.json` — machine-readable policy contract used at runtime
- `versioning.md` — required versioning practices for prompts/policies/controllers
- `rollback_rules.md` — rollback triggers and procedures
- `governance/evidence_packs/` — intended evidence-pack location when self-improve cycles produce immutable evidence; the directory is not present until evidence is generated

> Runtime uses `contracts/loop_contract.v1.json` as the machine-readable source of truth.

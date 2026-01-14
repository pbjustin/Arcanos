# SQL ORM Recommendation: Prisma vs Knex

## Summary
Prisma should be the primary ORM for ARCANOS because it offers schema-first workflows, strong typing, and migration tooling that aligns with our documented Prisma setup. Knex remains acceptable for targeted infrastructure concerns that benefit from low-level SQL control (e.g., session caches or audit logging), but it should not be the default for domain data access.

## Assumptions
- We want one primary data access pattern to reduce cognitive load and onboarding time.
- We prefer schema-driven development with repeatable migrations.
- We still allow raw SQL when the ORM cannot express a query efficiently.

## Recommended Default Choice
**Choose Prisma for new domain data access and core application models.**

Why:
- Prisma is already documented as the primary ORM and supports schema-as-source-of-truth workflows.
- Prisma provides type-safe queries and migration tooling that reduce runtime errors and drift.
- Prisma is a better fit for developer velocity and maintainability in a growing codebase.

## When Knex Is Still Acceptable
Knex can remain in narrow, infrastructure-oriented scopes when it provides concrete benefits:
- High-performance or complex SQL that Prisma cannot express cleanly.
- Thin persistence layers (e.g., session or cache tables) where raw SQL control is useful.
- Data pipelines or admin utilities that already rely on Knex.

In these cases, isolate Knex behind a dedicated module so the rest of the app stays ORM-agnostic.

## Recommendations to Improve SQL Layer Quality
1. **Standardize on a single primary ORM**
   - Use Prisma for all domain entities and core workflows.
   - Document any exceptions where Knex is allowed and why.

2. **Define a single migration source of truth**
   - Prisma migrations should be the canonical schema path for domain data.
   - Avoid separate migration stacks that drift over time.

3. **Create a DB access boundary**
   - Centralize all data access in a `src/db/` or `src/data/` layer.
   - Expose a minimal interface for CRUD operations and transactional workflows.

4. **Add query review guidelines**
   - Require performance review for queries that bypass Prisma.
   - Log or trace any raw SQL usage for easier auditing.

5. **Plan a phased consolidation**
   - Identify existing Knex usage, classify as domain vs infra.
   - Migrate domain tables to Prisma first; keep infra Knex only if justified.

## Minimal Test Plan (for SQL layer changes)
- **Happy path:** CRUD operations for core models succeed via Prisma.
- **Edge cases:** Unique constraints, null handling, and schema defaults behave as expected.
- **Failure modes:** Transaction rollback works for partial failures; raw SQL errors surface with clear logging.

## Next Actions
- Confirm whether we want to adopt Prisma as the default for all new work.
- Inventory current Knex usage and tag each use case as `domain` or `infra`.
- Create a migration backlog for any domain data still on Knex.

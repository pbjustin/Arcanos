---
name: arcanos-protocol-change
description: Implement ARCANOS protocol changes across JSON schemas, TypeScript consumers, Python consumers, contract tests, and maintained documentation. Use for command, noun, tool, ActionPlan, or Backstage contract changes and protocol drift repairs; ordinary internal refactors do not require this workflow.
---

# ARCANOS protocol change

Keep the public wire contract owned by TypeScript and make the smallest change that fulfills the request. Use the active ARCANOS repository/worktree and current `AGENTS.md`; paths below are repository-relative. Verify current source and scripts before acting because this skill is a workflow, not a frozen contract snapshot.

## Establish scope and ownership

Read `AGENTS.md`, the exact checkout/head and dirty state, root `package.json`, `packages/protocol/package.json`, and `docs/SCHEMA_PROTOCOL_GUIDE.md`. Trace the affected schema to validators, exported types, callers, response projection, and tests using `rg`. Identify whether the requested behavior changes the wire shape, command support, or only an implementation.

Honor authorization already granted for implementation and local validation. Preserve unrelated changes and use an isolated worktree when needed. A review-only request remains read-only. This skill does not authorize commits, pushes, Builder changes, deployments, live calls, or database operations. Ask about a broader redesign only if a surgical change cannot satisfy the request and that redesign has not already been approved.

Select the contract family before editing:

| Family | Owned surfaces and registration rule |
| --- | --- |
| Command envelope, nouns, and tools | `packages/protocol/schemas/v1/`; `packages/protocol/src/schemaCatalog.ts`; exported types/validators; `packages/protocol/src/commands.ts` only if supported or reserved commands change |
| ActionPlan execution | `packages/protocol/schemas/v1/action-plan/`; `src/shared/types/actionPlanExecution.ts`; `contracts/action_plan_execution.openapi.v1.json`; `daemon-python/arcanos/action_plan_execution_protocol.py`; focused TypeScript/Python/OpenAPI tests. **Do not add these schemas to `schemaCatalog.ts`.** |
| Backstage Booker module actions | `packages/protocol/schemas/v1/backstage-booker/`; protocol types and validators; the catalog's distinct `backstageBooker` section; `contracts/backstage_booker.openapi.v1.json` and affected server/consumer tests. Do not turn module actions into top-level protocol commands merely to register them. |

## Make the coordinated change

1. Update the owning JSON schema first. Preserve existing schema IDs, field spelling, required/optional behavior, limits, null handling, deterministic JSON, and response/error shapes unless the requested change requires a specific adjustment. Trace compatibility implications to actual callers; use the repository's versioning convention when a version change is required.
2. Update catalog registration where that family requires it, then shared TypeScript types, validators, package exports, and server/CLI/worker consumers. Modify `ARCANOS_PROTOCOL_COMMAND_IDS` and `ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS` only when the command set or support status changes. Reserved commands must not appear implemented without schemas and dispatcher behavior.
3. Stabilize the TypeScript contract before updating Python clients, constants, schema loaders, or runtime parsers. Python consumes the public shape and must not introduce competing semantics or acquire server-only capabilities. Check the relevant shared fixture corpus for cross-language parity.
4. Add or update tests that exercise the changed contract: accepted and rejected shapes, boundaries, response projection, or compatibility behavior relevant to the change. Prefer shared fixtures for TypeScript/Python agreement. For ActionPlan, inspect `tests/action-plan-execution-protocol-contract.test.ts`, `tests/openapi/action-plan-execution.contract.test.ts`, `tests/fixtures/action-plan-execution-protocol-v1.json`, and the affected `daemon-python/tests/test_action_plan_execution_*` tests. Select cases from the actual change rather than copying every suite.
5. Update affected maintained documentation and contracts. Protocol rules belong in `docs/SCHEMA_PROTOCOL_GUIDE.md`; routes in `docs/API.md`; package exports in `docs/WORKSPACE_PACKAGES.md`; CLI behavior in `docs/CLI_OVERVIEW.md`; daemon behavior in `daemon-python/README.md`; environment variables in both `.env.example` and `docs/CONFIGURATION.md`. Read `docs/DOCUMENTATION.md` for document ownership and generated-index rules.

Preserve NodeNext import spelling: local TypeScript imports use emitted `.js` specifiers, package exports remain extensionless. Use supported exports and aliases. Do not replace surrounding names or control flow, add dependencies, or rewrite configuration/lockfiles unless required by the task. Do not edit `dist/`, coverage, or caches as source. Structural source additions, moves, or deletions may require `npm run reindex`; inspect current rules and regenerate/review all four outputs together: `backend-index.json`, `cli-agent-index.json`, `docs/BACKEND_INDEX.md`, and `docs/CLI_AGENT_INDEX.md`.

Preserve routing and CEF boundaries. Job/result reads, runtime/queue/database inspection, and MCP control must not be routed through `/gpt/:gptId`; use approved direct or `/gpt-access/*` surfaces. Do not give protected planner/capability code direct filesystem, process, database, network, or queue access, or import production code from `legacy/`. An existing application memory interceptor is not a general control-plane route.

## Validate and finish

Re-read current Node/npm pins from root manifests and `.nvmrc` and use those exact versions. At skill creation these were Node `24.18.1` and npm `11.16.0`. Run npm commands at the repository root. Missing dependencies require setup within task authorization, not an implicit install or a substituted runtime.

The current protocol minimum is:

```text
npm run type-check
npm run lint
node scripts/run-jest.mjs --testPathPatterns=protocol --coverage=false
npm run validate:backend-cli:contract
npm run validate:backend-cli:offline
npm run sync:check
```

`type-check` currently rebuilds shared packages before consumer validation. If it no longer does, build packages first using the current root script. Add focused changed-family Jest/OpenAPI and Python tests; use the current `AGENTS.md` matrix for worker, database, or runtime changes. Run `npm run docs:check` when documentation or source layout changes. Confirm `sync:check` findings against current source because checker metadata can be stale; do not use `sync:fix` as a repair.

Use mocked/offline contract tests. Do not start workers, initialize a configured database, apply migrations, issue live memory/dispatcher calls, or exercise a provider merely to validate a shape. Preserve the task's separate authorization for any such operation and report what remained untested.

Review the final diff for unintended schema, generated, dependency, or tooling changes. Report the public behavior changed, coordinated surfaces, checks passed/failed/skipped, and any remaining compatibility or evidence limit. Tie results to the tested commit and local diff; local contract tests do not establish deployment or live consumer acceptance.

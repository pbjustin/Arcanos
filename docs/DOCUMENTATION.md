# Documentation maintenance

> Last reviewed: 2026-07-23

Arcanos keeps durable documentation with the code it describes. The current
source, executable configuration, tests, and required CI workflows remain more
authoritative than prose.

## Document lifecycle

Every document listed in the [documentation index](README.md) belongs to one of
these classes:

| Class | Meaning |
| --- | --- |
| Canonical | Maintained entry point for a current subsystem or workflow. |
| Companion | Focused detail that supplements a canonical guide. |
| Docs-as-contract | A fixed path or wording is consumed by tests or validators; coordinate document and validation changes. |
| Design-only | Proposed or local-only behavior that is not proof of implementation, deployment readiness, or authorization. |
| Generated | Rebuilt from source; do not hand-edit as the primary change. |
| Historical | Dated evidence or a decision snapshot; never use it as a current runbook without revalidation. |

New durable facts should go into an existing canonical owner. Avoid creating a
one-off refactor, migration, review, or status document when the information
belongs in a maintained guide, changelog entry, test, or dated audit record.

## Canonical ownership and review schedule

The accountable reviewer for maintained documentation is
[@pbjustin](https://github.com/pbjustin). The owner is responsible for making
sure a review happens and for approving material changes; other contributors
may still author and review documentation. [CODEOWNERS](../.github/CODEOWNERS)
routes documentation changes to that reviewer. Branch protection determines
whether the routed review is required.

An affected document must be reviewed in the same pull request as a behavior,
contract, dependency, or workflow change. The maximum interval below is a
backstop for drift when no triggering change is noticed, not permission to
postpone a known update. A review may result in no text change, but should
verify the guide against current source, tests, executable configuration, and
required CI. The repository-wide review completed on 2026-07-23 is the initial
baseline for the intervals below. A later content commit or pull request that
explicitly records a no-change review resets the interval for the named
document; formatting-only edits do not.

| Surface | Canonical document or record | Review trigger | Maximum interval |
| --- | --- | --- | --- |
| Routes, endpoints, and response contracts | [API.md](API.md) | Route, middleware, request, response, or authentication change | 90 days |
| Architecture and routing boundaries | [ARCHITECTURE.md](ARCHITECTURE.md) | Component, dependency, execution-boundary, or routing change | 90 days |
| CI and delivery | [CI_CD.md](CI_CD.md) | Required check, workflow, release, or environment-boundary change | 90 days |
| Environment variables | [CONFIGURATION.md](CONFIGURATION.md) and [../.env.example](../.env.example) | Variable, default, validation, or secret-handling change | 90 days |
| Local setup and diagnosis | [RUN_LOCAL.md](RUN_LOCAL.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Install, build, startup, developer-tool, or recurring-failure change | 90 days |
| Railway build and operations | [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md) | Build, launcher, health, topology, deploy, or rollback change; after a relevant incident | 90 days |
| Runtime resilience | [STARTUP_RESILIENCE.md](STARTUP_RESILIENCE.md), [REDIS_RESILIENCE_RUNBOOK.md](REDIS_RESILIENCE_RUNBOOK.md), and [SOLO_OPERATOR_RUNTIME_GUIDE.md](SOLO_OPERATOR_RUNTIME_GUIDE.md) | Dependency lifecycle, recovery, monitoring, authentication, or operator-workflow change; after a relevant incident | 90 days |
| OpenAI construction and tools | [OPENAI_RESPONSES_TOOLS.md](OPENAI_RESPONSES_TOOLS.md) | SDK, model, adapter, tool, streaming, retry, or retention change | 90 days |
| Workspace packages and exports | [WORKSPACE_PACKAGES.md](WORKSPACE_PACKAGES.md) | Workspace, export-map, package API, or shared-helper change | 90 days |
| Public protocol and schemas | [SCHEMA_PROTOCOL_GUIDE.md](SCHEMA_PROTOCOL_GUIDE.md) | Command, schema, catalog, validator, or TypeScript-Python contract change | 90 days |
| Database and migrations | [DATABASE_MIGRATIONS.md](DATABASE_MIGRATIONS.md) | Schema, migration, repository, initialization, or validation change | 90 days |
| GPT access and memory | [gpt-access-gateway.md](gpt-access-gateway.md) and [MEMORY_BACKEND_USAGE.md](MEMORY_BACKEND_USAGE.md) | Gateway, scope, confirmation, persistence, retrieval, or authorization-boundary change | 90 days |
| TypeScript CLI behavior | [CLI_OVERVIEW.md](CLI_OVERVIEW.md) | Command, flag, transport, output, or packaging change | 90 days |
| Python daemon behavior | [../daemon-python/README.md](../daemon-python/README.md) | Command, daemon API, protocol consumer, install, or packaging change | 90 days |
| Documentation governance and navigation | This document and [README.md](README.md) | Canonical-owner, lifecycle, naming, generated-index, or checker change | 180 days |
| Release-facing changes | [../CHANGELOG.md](../CHANGELOG.md) | Every release or user-visible compatibility change | Every release |

Security contracts, GPT-OSS validators, and migration-local READMEs may have
additional fixed-path requirements. Check nearby tests and validation scripts
before moving, merging, or renaming them.

## Generated documentation

`npm run reindex` rewrites these four files together:

- [BACKEND_INDEX.md](BACKEND_INDEX.md)
- [CLI_AGENT_INDEX.md](CLI_AGENT_INDEX.md)
- [../backend-index.json](../backend-index.json)
- [../cli-agent-index.json](../cli-agent-index.json)

Run it after structural source changes. Review all four outputs and do not edit
generated indexes as substitutes for correcting source organization.

## Historical evidence

Canonical and companion guides describe current supported behavior. Test
results, approval records, proposals, incident timelines, point-in-time
topology, and migration observations are historical evidence even when they
were produced during work on a canonical guide. Put the durable conclusion or
current procedure in the canonical guide and keep the supporting snapshot
under [audits/](audits/). Do not turn a maintained guide into a chronological
evidence log.

Use this layout for new tracked documentation evidence sets:

```text
docs/audits/<topic>/YYYY-MM-DD/<optional-scope>/
```

- Use lower-kebab-case for `<topic>`, `<optional-scope>`, and artifact names.
- Use the UTC capture or incident-start date. Put the date in the directory,
  not every filename.
- For incidents, use `docs/audits/incidents/YYYY-MM-DD/<incident-slug>/`.
- A single small artifact may live directly in the dated directory. Give a
  multi-file evidence set a `README.md` that identifies its historical
  lifecycle, purpose, capture boundary, validation status, relevant canonical
  guide, and whether any included action was merely proposed or actually
  authorized and executed.
- Keep machine-readable results in stable formats such as JSON or CSV and
  redact credentials, tokens, personal data, and sensitive payloads before
  tracking them.
- If a test or validator consumes an evidence path, treat it as docs-as-contract
  and update the consumer in the same change.
- Machine-enforced evidence stores with an existing contract, such as
  `governance/evidence_packs/`, remain at that contract-defined path.

Existing evidence directories are grandfathered: do not move them solely to
match this convention. Apply the layout to new evidence sets, and normalize an
old set only when a scoped change already requires moving it and all inbound
references can be updated. Tracked historical evidence should otherwise remain
immutable; add a new dated artifact or an explicitly identified correction
instead of silently rewriting a captured result.

Untracked audit artifacts belong to their creator until explicitly brought into
scope. Do not rewrite or delete them as incidental documentation cleanup.

Operational documents never grant authority to deploy, mutate a database,
change variables, restart services, or invoke a live provider. Those actions
still require the repository's normal target confirmation and approval gates.

## Consolidating or deleting documents

Merge or delete a document when its durable content has a clear canonical owner
and all inbound references have been repaired. Before deletion:

1. Verify the replacement against current source, tests, configuration, and CI.
2. Move unique, current guidance into the canonical owner.
3. Search code, tests, validators, workflows, and Markdown for path references.
4. Preserve dated evidence under `docs/audits/` when history is material.
5. Run the documentation and affected subsystem checks.

Use a short redirect only when external consumers are likely to depend on the
old path. Repository-internal completed plans and duplicate guides should be
removed once their durable content and references are consolidated.

## Validation

Run the cross-platform documentation check from the repository root:

```bash
npm run docs:check
```

The check validates required canonical files, retired-document cleanup,
conventional Markdown link targets, stale terminology, unsafe probe
recommendations, and coverage of top-level `docs/*.md` files in the
documentation index. The legacy Bash entry point delegates to the same check:

```bash
./scripts/doc_audit.sh
```

Validate maintained-document links locally without network access:

```bash
npm run docs:links -- --local-only
```

The read-only [Documentation Link Audit](../.github/workflows/documentation-links.yml)
runs every Monday at 13:17 UTC and on manual dispatch. It checks external links
with bounded concurrency, redirects, retries, and timeouts, then uploads a
redacted JSON report. Definitive broken links fail the scheduled run;
access-restricted or transient network results remain warnings. Historical
evidence under `docs/audits/` is excluded because it is an immutable snapshot,
not maintained navigation.

Use real Markdown links for navigation. Backticked paths are appropriate for
copyable source locations and commands, but they are not substitutes for links
in an index.

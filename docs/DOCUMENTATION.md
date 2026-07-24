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

## Canonical owners

| Change | Documentation owner |
| --- | --- |
| Routes, endpoints, and response contracts | [API.md](API.md) |
| Architecture and routing boundaries | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Environment variables | [CONFIGURATION.md](CONFIGURATION.md) and [../.env.example](../.env.example) |
| Local setup and startup | [RUN_LOCAL.md](RUN_LOCAL.md) |
| Railway build, start, health, and rollback behavior | [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md) |
| OpenAI construction, Responses, tools, and streaming | [OPENAI_RESPONSES_TOOLS.md](OPENAI_RESPONSES_TOOLS.md) |
| Workspace packages and exports | [WORKSPACE_PACKAGES.md](WORKSPACE_PACKAGES.md) |
| Public protocol and schema changes | [SCHEMA_PROTOCOL_GUIDE.md](SCHEMA_PROTOCOL_GUIDE.md) |
| Database and migrations | [DATABASE_MIGRATIONS.md](DATABASE_MIGRATIONS.md) |
| Python daemon behavior | [../daemon-python/README.md](../daemon-python/README.md) |
| TypeScript CLI behavior | [CLI_OVERVIEW.md](CLI_OVERVIEW.md) |
| Release-facing changes | [../CHANGELOG.md](../CHANGELOG.md) |

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

Tracked files under [audits/](audits/) are dated evidence. Preserve them when
tests, approvals, incident review, or migration history depend on their exact
content. They are not part of the active reading path.

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

Use real Markdown links for navigation. Backticked paths are appropriate for
copyable source locations and commands, but they are not substitutes for links
in an index.

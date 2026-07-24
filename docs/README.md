# Arcanos documentation

This is the navigation map for tracked Arcanos documentation. Start with the
[repository overview](../README.md), then use the canonical guide for the
subsystem you are changing.

Current source, executable configuration, tests, and required CI workflows take
precedence over prose. See [Documentation maintenance](DOCUMENTATION.md) for
ownership, lifecycle, consolidation, and validation rules.

## Lifecycle

| Label | Use |
| --- | --- |
| Canonical | Maintained source of truth for a current workflow or subsystem. |
| Companion | Focused detail that supplements a canonical guide. |
| Docs-as-contract | Tests or validators consume the path or content; coordinate changes. |
| Design-only | Proposal or local-only gate, not proof of implementation or authorization. |
| Generated | Rebuild from source rather than editing by hand. |
| Historical | Dated evidence or snapshot; revalidate before operational use. |

## Start here

| Goal | Guide |
| --- | --- |
| Understand the system | [Architecture](ARCHITECTURE.md) |
| Install and run locally | [Local runbook](RUN_LOCAL.md) |
| Configure the backend | [Configuration](CONFIGURATION.md) |
| Find a supported HTTP surface | [API](API.md) |
| Work across packages | [Workspace packages](WORKSPACE_PACKAGES.md) |
| Change a protocol or schema | [Schema and protocol guide](SCHEMA_PROTOCOL_GUIDE.md) |
| Work on PostgreSQL or migrations | [Database and migrations](DATABASE_MIGRATIONS.md) |
| Deploy or roll back on Railway | [Railway deployment](RAILWAY_DEPLOYMENT.md) |
| Diagnose a local problem | [Troubleshooting](TROUBLESHOOTING.md) |
| Contribute a change | [Contributing](../CONTRIBUTING.md) |

## Canonical engineering guides

- [API](API.md) — primary supported HTTP surfaces and contracts.
- [Architecture](ARCHITECTURE.md) — repository map, routing planes, jobs, and
  runtime topology.
- [CI/CD](CI_CD.md) — required workflows and environment separation.
- [Configuration](CONFIGURATION.md) — environment variables and defaults.
- [Database and migrations](DATABASE_MIGRATIONS.md) — schema ownership and
  safe migration workflow.
- [Documentation maintenance](DOCUMENTATION.md) — documentation ownership and
  lifecycle policy.
- [OpenAI Responses and tools](OPENAI_RESPONSES_TOOLS.md) — adapter boundaries,
  tool continuations, retention, retries, and tracing.
- [Railway deployment](RAILWAY_DEPLOYMENT.md) — build, launcher, health,
  approval, deploy, and rollback behavior.
- [Local runbook](RUN_LOCAL.md) — backend, worker, and optional daemon setup.
- [Schema and protocol guide](SCHEMA_PROTOCOL_GUIDE.md) — TypeScript-owned
  protocol and ActionPlan contract families.
- [Troubleshooting](TROUBLESHOOTING.md) — focused local diagnostics.
- [Workspace packages](WORKSPACE_PACKAGES.md) — package ownership, exports, and
  validation.

## Runtime, CLI, and product guides

| Document | Lifecycle | Scope |
| --- | --- | --- |
| [Arcanos Gaming Custom GPT](ARCANOS_GAMING_CUSTOM_GPT.md) | Docs-as-contract | Builder instructions and OpenAPI contract expectations. |
| [MCP server](ARCANOS_MCP_SERVER.md) | Companion | Current MCP transports, tools, principals, and gates. |
| [CEF hardening controls](cef-hardening-controls.md) | Companion | CEF dispatch and validation controls. |
| [CLEAR 2.0](CLEAR_METHOD_2_0.md) | Companion | CLEAR scoring and decision behavior. |
| [TypeScript CLI overview](CLI_OVERVIEW.md) | Canonical | `@arcanos/cli` commands and transports. |
| [Custom GPTs](CUSTOM_GPTS.md) | Companion | Module-bound GPT behavior and builder workflows. |
| [Execution contract](execution_contract.md) | Companion | Compact execution invariants. |
| [Fine tuning](FINE_TUNING.md) | Companion | Dataset and checkpoint workflow. |
| [Async documentation workflow](GPT_ASYNC_DOCUMENTATION_WORKFLOW.md) | Generated | Output target for the CLI documentation generator; verify against API and source. |
| [GPT fast path](GPT_FAST_PATH.md) | Companion | Inline prompt-generation behavior and fallback. |
| [GPT Access gateway](gpt-access-gateway.md) | Canonical | Protected control-plane API, dispatch, scopes, and safety. |
| [Memory backend](MEMORY_BACKEND_USAGE.md) | Canonical | Persistence semantics and safe usage. |
| [Predictive self-healing](PREDICTIVE_SELF_HEALING.md) | Companion | Predictive healing configuration and execution. |
| [Self reflections](SELF_REFLECTIONS.md) | Companion | Reflection and feedback persistence. |
| [Solo operator runtime](SOLO_OPERATOR_RUNTIME_GUIDE.md) | Canonical | Operator-facing runtime and authentication guide. |
| [Trinity pipeline](TRINITY_PIPELINE.md) | Companion | Writing-plane generation pipeline. |
| [Web search agent](WEB_SEARCH_AGENT.md) | Companion | Retrieval and evidence handling. |

The Python daemon has its own canonical
[README](../daemon-python/README.md). The TypeScript and Python executables can
both be installed as `arcanos`; their guides explain unambiguous invocation.

## Operations and resilience

| Document | Lifecycle | Scope |
| --- | --- | --- |
| [Railway rationale](RAILWAY_RATIONALE.md) | Companion | Why Railway is the preferred target and when to reconsider. |
| [Startup resilience](STARTUP_RESILIENCE.md) | Canonical | Listener, dependency lifecycle, and health semantics. |
| [Redis resilience runbook](REDIS_RESILIENCE_RUNBOOK.md) | Canonical | Redis outage diagnosis and recovery boundaries. |
| [Railway Redis lifecycle preview](RAILWAY_REDIS_LIFECYCLE_PREVIEW.md) | Design-only / approval-gated | Isolated preview proof procedure; not routine validation or deployment authority. |

Operational prose does not authorize live probes, deployments, restarts,
variable changes, database access, or provider calls.

## GPT-OSS local runtime and private-serving design

GPT-OSS documentation describes a local controlled runtime plus design-only
private-serving gates. It does not prove public serving, production readiness,
Custom GPT readiness, or authorization to connect to live infrastructure.

### Local runtime

- [Local runtime guide](GPTOSS_LOCAL_RUNTIME.md)
- [Runtime architecture](GPTOSS_RUNTIME_ARCHITECTURE.md)
- [Database governance](GPTOSS_DB_GOVERNANCE.md)
- [Railway bridge](GPTOSS_RAILWAY_BRIDGE.md)

### Private-serving boundary and operations

- [Private endpoint contract](GPTOSS_PRIVATE_ENDPOINT_CONTRACT.md)
- [Private-serving boundary](GPTOSS_PRIVATE_SERVING_BOUNDARY.md)
- [Threat model](GPTOSS_PRIVATE_SERVING_THREAT_MODEL.md)
- [Private-serving runbook](GPTOSS_PRIVATE_SERVING_RUNBOOK.md)
- [Operations readiness](GPTOSS_PRIVATE_SERVING_OPERATIONS_READINESS.md)
- [Incident response](GPTOSS_PRIVATE_SERVING_INCIDENT_RESPONSE.md)
- [Go/no-go checklist](GPTOSS_PRIVATE_SERVING_GO_NO_GO_CHECKLIST.md)
- [Final readiness review](GPTOSS_PRIVATE_SERVING_FINAL_READINESS_REVIEW.md)
- [Phase 6 entry criteria](GPTOSS_PHASE6_IMPLEMENTATION_ENTRY_CRITERIA.md)
- [Production no-go checklist](GPTOSS_PRODUCTION_NO_GO_CHECKLIST.md)

### Durable replay, keys, and rate limiting

- [Durable replay store design](GPTOSS_DURABLE_REPLAY_STORE_DESIGN.md)
- [Durable replay implementation plan](GPTOSS_DURABLE_REPLAY_STORE_IMPLEMENTATION_PLAN.md)
- [Durable replay implementation readiness](GPTOSS_DURABLE_REPLAY_IMPLEMENTATION_READINESS.md)
- [Durable replay security review](GPTOSS_DURABLE_REPLAY_SECURITY_REVIEW.md)
- [Durable replay rollback plan](GPTOSS_DURABLE_REPLAY_ROLLBACK_PLAN.md)
- [Production key-management design](GPTOSS_PRODUCTION_KEY_MANAGEMENT_DESIGN.md)
- [Key-rotation runbook](GPTOSS_KEY_ROTATION_RUNBOOK.md)
- [Durable rate-limit design](GPTOSS_DURABLE_RATE_LIMIT_DESIGN.md)
- [Rate-limit runbook](GPTOSS_RATE_LIMIT_RUNBOOK.md)

Most private-serving documents are docs-as-contract and are consumed by
validators or tests. Preserve their paths unless the corresponding validators
and tests are intentionally migrated.

## Security and execution contracts

These documents combine normative rules with dated decision evidence. Read
their lifecycle notes before treating present-tense snapshot statements as
current topology.

- [ActionPlan execution ownership](security/action-plan-execution-ownership-contract.md)
- [ActionPlan lifecycle](security/action-plan-lifecycle-contract.md)
- [ActionPlan migration-attempt history](security/action-plan-migration-attempt-history.md)
- [Arcanos Core advisory bridge](security/arcanos-core-advisory-bridge.md)
- [CLEAR decision contract](security/clear-decision-contract.md)
- [Credential verification](security/credential-verification-contract.md)

Migration-local implementation notes live beside their artifacts under
[migrations/](../migrations/).

## Generated indexes and historical evidence

- [Backend TypeScript index](BACKEND_INDEX.md) — generated by
  `npm run reindex`.
- [Python CLI index](CLI_AGENT_INDEX.md) — generated by `npm run reindex`.
- [Dated audits](audits/) — historical evidence, proposals, incident reviews,
  and approval records; not the active operational path.
- [2026-04-29 refactor audit](audits/reusable-code/2026-04-29/refactor-audit.md)
  — relocated baseline snapshot retained only as historical evidence.
- [Governance](../governance/README.md) — consolidated self-improvement
  versioning, branch-protection, rollback, and evidence policy.
- [Deprecation register](../DEPRECATION.md) — compatibility and removal
  candidates; dates alone never authorize deletion.

## External references

- [OpenAI API documentation](https://platform.openai.com/docs)
- [OpenAI Node SDK](https://github.com/openai/openai-node)
- [OpenAI Python SDK](https://github.com/openai/openai-python)
- [Railway documentation](https://docs.railway.com/)
- [Railway CLI documentation](https://docs.railway.com/develop/cli)

# Platform requirements and client evidence

Historical PR #1508 snapshot. Current Tutor connection evidence and migration
gates are in the [Tutor platform reconciliation](TUTOR_PLATFORM_RECONCILIATION.md)
and [migration handoff](TUTOR_MIGRATION.md). Setup-pending statements below
describe the foundation PR, not the subsequently connected account.

Access date: **2026-09-22**. These are fetched official documentation findings,
not evidence that this account has the corresponding controls. No account,
workspace, Builder configuration, installed plugin, or mobile client was changed.

## Sources and requirements used

| Requested source | Resolved source | Requirement used |
| --- | --- | --- |
| [Custom GPT retirement and migration FAQ](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq) | Same URL | Migration uses the latest published Builder version; instructions and knowledge can transfer, custom Actions and conversations do not. Migration availability is account/workspace dependent. The announced retirement is December 11, 2026, subject to the account's notice. |
| [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256) | Same URL | A plugin packages skills/apps; app authorization and workspace access remain separate. Imported MCP declarations may make a plugin Desktop only even for an HTTPS server. A registered app reference alone does not remove the restriction. Personal Skills availability is plan/workspace/surface dependent. |
| [Authenticate users](https://developers.openai.com/plugins/build/auth) | Same URL | Authenticated MCP uses OAuth 2.1: protected resource metadata, provider discovery, resource/audience binding, PKCE S256, and per-request issuer/audience/expiry/scope validation. CIMD is preferred when supported; DCR and predefined clients remain options. Copy actual callback settings from the registered connection. Tool authentication metadata does not replace execution checks. |
| [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server) | Same URL | Streamable HTTP, explicit input/output schemas, useful text and structured results, effect-based annotations, server-side authorization. UI is optional. Initialization and calls must be tested; a healthy HTTPS endpoint is insufficient. |
| [Package your plugin](https://developers.openai.com/plugins/build/plugins) | Same URL | New packages use root `plugin.json` with the Agent Plugins 1.0.0 schema; `skills/` is discovered conventionally. Registered app mappings use `.app.json` via `extensions.com.openai.apps`. Existing `.codex-plugin/plugin.json` remains a compatibility fallback. |
| [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) | Same URL | Test MCP independently, then the installed skill/tool experience. HTTPS or an approved tunnel enables development connection, subject to eligibility. Refresh connection metadata and rerun representative prompts after tool changes. Public submission requires public HTTPS. |
| [Security and privacy](https://developers.openai.com/plugins/guides/security-privacy) | Same URL | Minimize permissions and returned data, enforce input checks on the server, avoid secret/raw-prompt logging, and preserve confirmation for irreversible actions. |
| [Codex subagents](https://developers.openai.com/codex/subagents) | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | Delegate bounded independent work and return distilled evidence. Concurrent writes require explicit ownership to avoid conflicts. |
| [Prompt guidance](https://developers.openai.com/api/docs/guides/prompt-guidance) | [Model guidance](https://developers.openai.com/api/docs/guides/latest-model) | Clarify instruction priority, avoid ambiguous skill guidance, and carry authorized work through completion. This redirect does not require a model migration; backend model selection remains unchanged. |
| [Build skills](https://developers.openai.com/plugins/build/skills) | Same URL | Focus activation and non-activation, exact tool workflow, missing-information behavior, and representative positive/negative prompts. `SKILL.md` requires name and description frontmatter. Server authentication is separate from skill guidance. |
| [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) | Same URL | The current custom MCP article explicitly says mobile is unavailable (web only). Full MCP is documented for Business/Enterprise/Edu; Pro has a narrower read/fetch developer-mode path. Account access remains unverified. |
| [Portable manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) | Same URL, linked by OpenAI package documentation | Validate the real versioned schema using Ajv 2020. A hash-pinned local snapshot makes the source check offline and repeatable. |

The package page's portable schema is newer than the installed plugin-creator
scaffolder's compatibility-only layout. The latter remains supported, but this PR
uses the documented portable schema as a **template**, not an invented legacy
`ai-plugin.json` manifest. The skills page includes a legacy manifest example;
the dedicated package page explicitly defines current portable field placement.

Developer documentation currently describes Settings > Security and login and
the Plugins connection screen; the custom MCP help article retains Apps/admin
flows and narrower availability statements. Those pages do not establish what
this user's account exposes. Follow actual eligible controls when separately
authorized, and retain the explicit mobile limitation until current documentation
and an actual account/device test establish a supported path. A general statement
that some plugins run across products is not proof of this custom connection's
iOS support.

## Chosen boundary and packaging decision

The backend foundation is an OAuth resource server at `/chatgpt/mcp`, separate
from operator MCP and existing GPT Actions. An approved external provider must
issue resource-bound user access tokens. The sole planned tool is `arcanos_tutor`;
skills cannot grant its scope. Account provisioning, provider policy, registration,
and distribution remain separate work. No custom authorization server is built.

The Tutor skill and manifest are [release staging](../../integrations/tutor-pilot/README.md).
There is no registered app ID, active manifest, bundled MCP declaration, marketplace,
or fabricated endpoint. The validator confirms the manifest schema and permitted
contents; release mode deliberately exits 2 until a subsequent reviewed connection
stage replaces the blocker. It neither installs a development plugin nor publishes
a ChatGPT package. Unresolved dependency metadata is documented rather than made
to look usable.

The pilot uses synchronous generic tutoring. It does not include the legacy GPT
route's queue/persistence semantics, Tutor domain/module selection, scholarly search,
or backend conversation hydration. Those are inventory items requiring later
authorization/ownership decisions, not hidden capabilities of this package.

## Compatibility and evidence matrix

| Surface or stage | Documentation position | Evidence in this PR |
| --- | --- | --- |
| GPT-to-plugin migration | Published instructions/reference transfer may be offered; Actions require replacement | NOT RUN; current GPTs are untouched; live Builder exports unavailable |
| Registered authenticated integration | OAuth resource server plus actual account/provider connection | Repository boundary implemented/tested separately; real account authorization BLOCKED by configuration and eligibility |
| Locally imported plugin with MCP declaration | Local/Codex distribution can differ from web; HTTPS does not prevent Desktop only classification | NOT CREATED or INSTALLED |
| Codex MCP/plugin support | Documented local developer path; separate account/configuration controls | SDK component tests are not installed Codex behavior; NOT VERIFIED |
| ChatGPT web | Custom integration path exists for eligible accounts/workspaces | NOT VERIFIED; no connection or installed workflow test |
| ChatGPT iOS | Current custom MCP help article says web only | BLOCKED by documented custom-MCP limitation; no iPhone compatibility claim or device test |
| Public plugin distribution | Separate submission/review; a package is not a registered integration | NOT REQUESTED or RUN |

## Remaining user-controlled connection steps

These are preparation notes, not instructions executed by this PR:

1. Confirm the creating account/workspace, plan, role, migration notice, and actual
   plugin/custom-integration controls. Determine a documented iOS distribution path
   or await support; do not present web-only testing as the intended final experience.
2. Choose an approved existing identity provider and tenant. Confirm discovery,
   S256, resource-bound tokens, consented Tutor scope, client registration method,
   and refresh-token policy. Use the exact callback/client metadata displayed by
   the eventual registered connection. Do not create paid resources incidentally.
3. Identify an approved isolated non-production deployment and canonical HTTPS
   resource URL. Apply only its approved configuration and data isolation policy.
   Inspect transport/discovery before any authorized synthetic generation test.
4. Under separate authorization, register the integration and complete real OAuth.
   Record the actual app mapping privately, verify account/role access, and add only
   safe non-secret packaging metadata after reviewing its visibility requirements.
5. Reconcile published Builder instructions and missing knowledge files privately.
   Materialize a registered package only after every reference resolves, then run
   the prepared skill prompts in each supported client and record separate results.

Do not call a package schema check, token-fixture test, Railway health response,
or successful desktop invocation an installed ChatGPT web/iOS end-to-end result.

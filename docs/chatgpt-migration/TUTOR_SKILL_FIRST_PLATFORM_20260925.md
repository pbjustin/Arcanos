# ARCANOS TUTOR skill-first platform evidence

Official sources accessed **2026-09-25 UTC**. This dated research record supports
the repository package design. It does not establish account eligibility,
installation, migration, runtime acceptance, or capability parity. Private
Builder content and transcripts remain outside Git.

The [owner-approved published inventory](../../integrations/arcanos-tutor/baseline.inventory.json)
enables Web Search, Canvas, Image Generation, and Code Interpreter & Data
Analysis. The [capability ledger](../../integrations/arcanos-tutor/capability-equivalence.json)
binds these names to configuration SHA-256
`445255487dd270aad087e025b738666340ac1d42a2e45b05fe0b7df640e843bf` and
baseline fingerprint
`eb1d612dc2b4645841e3035a177ebb91fa6584a2ae633d7918972b9c9dd95e25`.
It records proposed equivalents and unexecuted tests; it contains no new
old-GPT or migrated-plugin observations.

Owner scope clarification recorded **2026-09-26T00:33:03Z**: the four features
above are host ChatGPT features used externally as needed, outside Tutor's
release-equivalence requirements. The research and proposed tests below remain
historical reference material, not remaining release tasks. Their results stay
NOT_TESTED; host availability and equivalence are not certified. The gate is
NOT_APPLICABLE under the [owner scope contract](TUTOR_INPUTS.md#host-capability-release-scope).

## Recommended package relationship

Use one plugin with a core tutoring skill that can answer ordinary learning
requests without the ARCANOS backend. Reserve the existing `arcanos_tutor`
connection for an explicitly requested backend operation when that tool is
available. Do not silently substitute the core answer for a claimed backend
result. This is the repository architecture decision; platform documentation
does not itself impose the explicit-backend-intent policy.

The [official migration guide](https://learn.chatgpt.com/docs/migrate-custom-gpts#understand-the-change)
distinguishes skills from service connections: skills-only workflows need no app
connection, and an unavailable optional app blocks only capabilities that need
it. Custom Actions require a separate replacement. Capability switches and a
selected GPT model do not guarantee identical migrated behavior.

Use the documented optional field, preserving the existing underlying app ID:

```json
{
  "apps": {
    "arcanos-tutor": {
      "id": "asdk_app_6ab4747769088191856fd8eb02507240",
      "optional": true
    }
  }
}
```

This representation has two primary supports:

- The [OpenAI package error reference](https://developers.openai.com/plugins/deploy/submission-errors#mcp-server-reference-errors)
  explicitly defines `optional` and `required` as boolean entry fields.
- OpenAI's [data-analytics app mapping at commit 1dc19589](https://github.com/openai/plugins/blob/1dc195897af4161d039b80d8471ec0a10c9bbc89/plugins/data-analytics/.app.json)
  uses `optional: true` on all 23 app entries and omits `required`. Its inspected
  Git blob is `d77eb02de2cbd82d0969902957e4cf90e18db29e`.

The [existing-app reference](https://learn.chatgpt.com/docs/enterprise/plugin-management#reference-an-existing-app-with-appjson)
requires the underlying `asdk_app_...` ID, without the URL's `plugin_` prefix,
and describes `required: true` for a dependent plugin. It does not document
omission defaults or precedence between both flags. Therefore use the explicit
`optional: true` example without a conflicting `required: true`; do not claim
that `required: false` alone was demonstrated by the inspected examples.
The mapping grants no new permissions and creates no connection.

The live [Agent Plugins 1.0.0 manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
was fetched read-only and structurally matched the
[pinned schema](../../integrations/arcanos-tutor/schemas/agent-plugins-1.0.0.schema.json).
Its extension objects intentionally have no portable semantics. Consequently,
portable-schema acceptance alone cannot validate optional-app behavior; the
strict repository app validator must enforce the reviewed OpenAI mapping.

## Activation, packaging, and privacy

[Build skills](https://learn.chatgpt.com/docs/build-skills#how-chatgpt-and-codex-use-skills)
documents explicit selection through `@` in ChatGPT and `/skills` or `$` in Codex
CLI/IDE, plus implicit matching against the skill description. A clear tutoring
description enables appropriate discovery; it does not guarantee selection on
every request. The Codex `allow_implicit_invocation` policy defaults to true;
do not add its false setting to the core skill. Test direct selection, an
ordinary learning request, and an unrelated request independently.

[Package your plugin](https://developers.openai.com/plugins/build/plugins#plugin-structure)
supports root `plugin.json`, fixed `skills/` discovery, and OpenAI-specific
`extensions.com.openai.apps` pointing to `./.app.json`. No bundled MCP server is
needed to reference the existing registered app. Local marketplaces support
private development/distribution; a local install is not proof that another
surface or workspace received the package. The public submission portal has a
different contract: its skills-only path excludes `.app.json`; see the
[submission error reference](https://developers.openai.com/plugins/deploy/submission-errors#zip-upload-errors-and-warnings).
Public submission is outside this task.

The [migration guide](https://learn.chatgpt.com/docs/migrate-custom-gpts#step-1-convert-your-gpt)
says a converted replacement begins private. Sharing and access must be checked
separately. Neither this researched design nor the source package is the actual
Migrate to plugin output. Release and migration approval remain separate gates.

## Surface limits and capability differences

[Current plugin guidance](https://learn.chatgpt.com/docs/plugins#overview) supports
plugin skills in Chat/Work on web, desktop, and mobile, with account/workspace
access restrictions. Desktop-only plugins cannot be used on mobile. Standalone
local skills and plugins have different availability; copying a skill into this
repository does not install it on web/mobile. The current guide excludes plugins
from the IDE extension even though standalone skills can be used there.

That general support does not certify this custom Tutor connection on mobile.
Keep the backend's existing surface limits and live-acceptance blocker separate
from the proposed app-independent core. No surface was exercised in this audit.

| Published capability | Proposed equivalent and explicit task intent | Surface constraints and proposed test | Current result |
| --- | --- | --- | --- |
| Web Search | Host web search for a request requiring current facts or cited research. Pure explanation need not invoke search. | [Web search](https://learn.chatgpt.com/docs/web-search) documents web/desktop search with workspace restrictions. Verify available search and inspect cited results on each intended surface; mobile-specific execution remains unverified. | NOT_TESTED; no migrated search result. |
| Canvas | Host document/code editing, file previews, or an interactive visualization when the user asks for an editable or interactive learning artifact. | [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) documents desktop previews/annotations and web file review. [Visualizations](https://learn.chatgpt.com/docs/visualizations#check-availability) has account-dependent web availability and desktop/mobile rollout. Create and revise one artifact per eligible surface. | NOT_TESTED; functional alternative only. Literal GPT Canvas editing/session parity is not established. |
| Image Generation | Host image generation/editing for an explicit illustration or image-edit request. | [Image generation](https://learn.chatgpt.com/docs/image-generation) documents web/desktop workflows; plan and workspace limits apply. Check image output, factual labels, and one requested revision. Mobile-specific execution remains unverified. | NOT_TESTED; no generated image or parity claim. |
| Code Interpreter & Data Analysis | Available host computation and file tools for requested calculation, supplied-data analysis, charts, or exports. | [ChatGPT Work](https://learn.chatgpt.com/docs/get-started-with-work) supports analysis and file tasks; [file guidance](https://learn.chatgpt.com/docs/artifacts-viewer) distinguishes desktop and web review. Test a small synthetic dataset with independently known results and an export; confirm actual execution tools per surface. | NOT_TESTED; the old interpreter environment, dependencies, persistence, and mobile execution are not guaranteed. |

Every test above is a future test method, not authorization to run a paid call,
install a package, change a connection, migrate a GPT, or publish anything. Record
the exact package, baseline, account surface, tool availability, and private
evidence reference when such testing is separately authorized. Keep source
checks distinct from actual installed-client evidence. All four capability
results and the combined migrated workflow remain unverified.

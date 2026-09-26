# ARCANOS TUTOR platform reconciliation

**Current architecture update (2026-09-25):** the owner selected skill-first
teaching with an optional backend. The [new platform record](TUTOR_SKILL_FIRST_PLATFORM_20260925.md)
supersedes this dated document's required-app design with supported `optional: true`.
The account identity and authorization boundary remain unchanged. Historical
requirements below describe the earlier integration candidate, not the current template.

Companion to [platform requirements](PLATFORM.md). Official sources below were
accessed on **2026-09-24 UTC** (2026-09-23 in the operator's local time). Recheck
them before migration or distribution when account controls or formats change.
Documentation establishes requirements; it does not prove account eligibility,
installation, migration, or parity. No account action is authorized by this guide.

## Requirements relied upon

| Official source | Requirements used for this package and handoff |
| --- | --- |
| [Custom GPT retirement and migration FAQ](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq) | Migration availability depends on the creating account/workspace. Use **My GPTs > ARCANOS TUTOR > Migrate to plugin** only after publishing essential edits and capturing the published baseline. The latest published version transfers; unpublished edits do not. Instructions become a skill, knowledge becomes references, and connected apps can transfer. Custom Actions, existing conversations, selected model, and sharing settings do not transfer. The replacement begins private and is not automatically installed. The original stays usable until retirement but becomes read-only and cannot be deleted by its creator. Review actual output and test familiar and difficult cases before relying on the replacement. The announced retirement is December 11, 2026, subject to the account notice. |
| [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) | The article documents Business/Enterprise/Edu full MCP on web and a narrower Pro read/fetch path. It explicitly lists custom MCP as web only. Workspace permissions govern developer access. Without refresh access, OAuth may require reauthentication after expiry. Workspace tool snapshots require review/refresh after changes; Enterprise/Edu and Business update controls differ. |
| [Authenticate users](https://developers.openai.com/plugins/build/auth) | Use authorization-code OAuth with PKCE S256, protected-resource discovery, issuer discovery, resource/audience binding, and server validation of token issuer, audience, expiry, and scopes. CIMD, DCR, and predefined clients are supported options. Copy the callback from the actual connection; never infer it. Tool `securitySchemes` metadata and OAuth challenges complement, rather than replace, authorization enforcement. |
| [Build skills](https://developers.openai.com/plugins/build/skills) | A focused `SKILL.md` needs name/description frontmatter, activation conditions, workflow, output requirements, clarification/stop rules, and supporting-file guidance. Skills describe tool use; the server owns authorization. Test direct, indirect, incomplete, unsupported, and difficult requests. MCP-imported skills are snapshots: redeploy and rescan before a new submitted version. |
| [Package your plugin](https://developers.openai.com/plugins/build/plugins) | New portable packages use root `plugin.json` declaring Agent Plugins 1.0.0. Fixed `skills/` discovery replaces a portable manifest `skills` field. OpenAI presentation and registered-app wiring belong in `extensions.com.openai`; `apps` points to `./.app.json`. An inline OpenAI extension replaces, rather than merges with, the compatibility overlay. Bundled-server `mcp.json` is a distinct optional component. |
| [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) | Verify HTTPS transport, discovery, schemas, annotations, authorization, and representative tool calls first; then install and test the combined skill/tool experience in a new conversation. After developer-mode tool/auth/UI metadata changes, update the server, select connection **Refresh**, inspect discovery, and rerun affected tests. Imported-skill or submitted-information changes require a new reviewed/published version. |
| [Security and privacy](https://developers.openai.com/plugins/guides/security-privacy) | Minimize scopes/data, validate every input and permission server-side, redact personal data in logs, avoid raw-prompt retention unless needed, and preserve human approval for irreversible actions. Plugin packaging must not include credentials. Widget CSP requirements apply when a widget exists; this Tutor package has no widget. |

## Registered app ID versus connection URL ID

The package page says to give the `plugin_asdk_app_...` connection URL identifier
to the plugin creator and describes the mapping using that shorthand. The
more specific [existing-app mapping reference](https://learn.chatgpt.com/docs/enterprise/plugin-management#reference-an-existing-app-with-appjson)
explicitly requires the underlying app ID in `.app.json`, **without** the
`plugin_` prefix. Its supported prefixes are `asdk_app_`, `connector_`, and
`templated_apps_`. The official [Figma mapping example](https://github.com/openai/plugins/blob/main/plugins/figma/.app.json)
corroborates the `apps` object containing named entries with an `id`.

Keep both identifiers in safe connection evidence with their distinct meanings:

| Meaning | Actual task-supplied connection metadata |
| --- | --- |
| Connection URL technical identifier | `plugin_asdk_app_6ab4747769088191856fd8eb02507240` |
| Underlying registered app ID used in `.app.json` | `asdk_app_6ab4747769088191856fd8eb02507240` |

The supported registered-app mapping for Tutor is:

```json
{
  "apps": {
    "arcanos-tutor": {
      "id": "asdk_app_6ab4747769088191856fd8eb02507240",
      "required": true
    }
  }
}
```

The manifest points to it through
`extensions["com.openai"].apps = "./.app.json"`. This reference neither creates
the connection nor grants access. It does not contain a tool allowlist: the
registered connection's reviewed catalog and backend enforcement must expose
exactly `arcanos_tutor`. Do not invent an app-level `tools` field or duplicate the
connection with an unneeded bundled MCP server declaration.

The skills page also demonstrates an `agents/openai.yaml` dependency for a
bundled MCP server. That example does not establish a second required connection
for an existing registered app. Tutor uses its required app reference and explicit
single-tool workflow; installed skill/tool behavior still needs verification.

## Surfaces and refresh boundaries

The [plugin availability and import guidance](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex)
says directory visibility does not establish access to every plugin or skill.
Plan, workspace, role, region, and surface still apply. Imported MCP declarations
can cause a Desktop only classification even with HTTPS; adding an app reference
does not itself remove it. Personal Skills have their own availability limits.
Consequently, a successful Tutor MCP call on web does not verify this complete
skill package, mobile support, or migration availability.

Developer documentation currently uses **Settings > Security and login** and
the Plugins connection screen; the custom-MCP help article also describes
Apps/admin flows. Follow the actual eligible controls and preserve this documented
difference instead of asserting one universal UI path. No supported iOS result
is established here; retain **mobile not verified**, with the custom-MCP article's
web-only limitation explicitly recorded.

Use the refresh action for the changed layer:

- Developer-mode MCP metadata: connection **Refresh**, inspect the discovered
  catalog, then test in a new chat.
- MCP-imported skill: deploy the changed source and **Scan Tools** again; the
  imported files are a snapshot, not a runtime fetch.
- Submitted plugin/skill: create, review, and publish a new version.
- Local marketplace package: update its referenced directory and restart the
  desktop app, following the package guide.
- Workspace GitHub marketplace: **Sync now**; list refresh only reloads the list.

## Differences from PR #1508

The portable schema, OpenAI extension, OAuth boundary, and requirement for
separate installed-workflow tests remain current. The legacy manifest example
at the end of the skills page does not override the dedicated portable-package
specification. Do not switch to the compatibility layout merely to match it.

PR #1508 intentionally had a template and no registered mapping. Actual safe
connection metadata can now replace that packaging blocker; it cannot replace
the required published Builder baseline, actual migrated skill/references, or
parity evidence. The published baseline now has a separate
[owner-approved capture](TUTOR_BASELINE_CAPTURE_20260925.md); migrated artifacts
and parity remain blocked. The app-ID distinction above is explicit and testable.

PR #1508's future setup instructions assumed an unconfigured nonproduction
connection. Current connection and deployment evidence must instead be recorded
separately, without repeating setup, changing production, or interpreting a
successful model response as completed GPT migration. The web/mobile cautions
and limits of schema-only validation remain applicable.

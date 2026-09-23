# ChatGPT Tutor authentication decision

Decision recorded before implementation on 2026-09-22. This is a resource-server foundation, not an authorization server, registered ChatGPT connection, account installation, or completed OAuth flow.

The pilot adds `/chatgpt/mcp` beside the existing operator `/mcp` route. It uses the existing `jose` dependency to verify OAuth access tokens issued by a separately approved established identity provider. Only the `arcanos:tutor` permission is usable. The integration starts disabled, and incomplete configuration disables its operations without aborting application startup or changing existing GPT Action routes. No approved identity-provider tenant or real account authorization was established for this PR.

## Verified requirements used

Official documentation accessed 2026-09-22:

| Source | Requirement used |
| --- | --- |
| [OpenAI authentication](https://developers.openai.com/plugins/build/auth) | OAuth 2.1 authorization-code flow with PKCE S256; resource-server metadata; exact issuer/resource binding; signature, expiry, audience and scope checks on every request. Use an established identity provider. CIMD is preferred when supported and selected; DCR and predefined clients remain alternatives. |
| [OpenAI MCP server construction](https://developers.openai.com/plugins/build/mcp-server) | Streamable HTTP with the maintained MCP SDK, focused typed tools, authorization inside execution, accurate effect annotations, bounded results and no secrets. |
| [OpenAI security and privacy](https://developers.openai.com/plugins/guides/security-privacy) | Least privilege, input validation, scope enforcement on every call, sanitized logging and no authentication via prompts or model instructions. |

The current documentation distinguishes identifying the OpenAI client from authenticating the end user. OpenAI-managed mTLS or published egress ranges do not replace OAuth authorization. Machine-to-machine grants and custom API keys are not the selected authenticated ChatGPT flow. Existing ARCANOS operator and purpose-bound Action tokens therefore remain separate and are explicitly rejected at this boundary.

The selected access-token profile is a signed JWT with protected-header `typ: at+jwt`, using RS256 or ES256. This profile is an ARCANOS constraint to distinguish access tokens from OIDC ID tokens; it is not a claim that every provider's default access-token profile already matches it. Configure the approved provider accordingly, or review a separately typed provider adapter before enabling a different token profile. Opaque-token introspection is outside this PR.

## Resource-server contract

| Configuration name | Requirement |
| --- | --- |
| `CHATGPT_MCP_ENABLED` | Exact `true` enables configuration evaluation. Missing, `false`, or any other value leaves the boundary disabled. |
| `CHATGPT_MCP_RESOURCE` | Canonical public HTTPS URL ending in the exact `/chatgpt/mcp` path, with no query, fragment or userinfo. The provider must mint this exact audience. |
| `CHATGPT_MCP_ISSUER` | Exact approved HTTPS issuer identifier, preserving trailing slash semantics; no query, fragment or userinfo. |
| `CHATGPT_MCP_JWKS_URL` | Approved issuer's HTTPS public signing-key endpoint; no query, fragment or userinfo. This is server configuration, never a tool argument or token-provided URL. |

Serve metadata at `/.well-known/oauth-protected-resource/chatgpt/mcp`, derived from the configured resource origin. The metadata declares the exact resource, one approved issuer, and only `arcanos:tutor`. Authentication challenges advertise that URL and scope. The route must never derive them from untrusted forwarded host headers.

Verification requires a bounded Bearer JWT, allowed asymmetric algorithm, access-token type, signature from the configured JWKS, exact `iss`, exact expected `aud`, nonblank bounded `sub`, numeric `iat` and `exp`, current validity including `nbf` when present, and the `arcanos:tutor` scope. JWTs cannot select key endpoints using `jku`/`x5u` or select their own audience. JWKS retrieval uses a three-second timeout, ten-minute key cache and thirty-second refresh cooldown; `jose` rejects redirect responses. The verifier returns a minimal immutable principal and never exposes the token, original claims, internal exception or verification diagnostics. Scope and expiration are rechecked immediately before Tutor execution. There is no operator-principal fallback.

Local issuer/key fixtures can supply a key resolver to the same verifier. They still perform real asymmetric signature and claims verification. The fixture seam is an in-process constructor option; it is unavailable through HTTP, tool arguments or runtime environment. Such tests prove the resource-server boundary and do not prove provider registration, consent, refresh, revocation or actual ChatGPT linking.

Malformed/expired credentials receive a sanitized 401 and challenge. Valid tokens without Tutor scope receive 403 `insufficient_scope` and a scope challenge. Disabling the integration or incomplete configuration admits no tools or generation. No authentication exception is logged, and no raw prompt or credential is included in this module's logs (it has no logging side effects).

The pre-authentication client throttle uses the existing trusted ingress identity policy: the normalized socket peer by default, or a verified Railway edge's `X-Real-IP` when `PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP` permits it. Caller-supplied `X-Forwarded-For` values cannot select a new bucket. Verified issuer/subject limits and shared provider admission remain separate checks after authentication.

## Identity, sessions and permission boundaries

The credential's verified issuer and subject identify the caller. A display name, skill name, GPT name, claimed role, MCP transport session, ARCANOS `sessionId`, or supplied conversation text grants no authority. The narrow pilot has no job read tool, memory permission, universe authority, source access, canon write, administrative operation or generic module dispatch.

Existing session hydration requires separately authorized backend records and deployment-wide memory-plane permission. That permission is not a per-user ownership binding. The pilot does not inherit it. Connecting a Tutor account does not complete the backend-memory migration.

## External prerequisites before connection

1. Choose and approve an existing non-production provider tenant. It must support authorization-code + PKCE S256, public discovery metadata, exact resource propagation, this JWT profile and an explicitly granted `arcanos:tutor` scope for approved pilot users. Do not give every authenticated identity broad access.
2. Select CIMD when supported, otherwise DCR or a predefined client. Configure the actual client authentication method supported by both parties. Do not copy an illustrative client ID or create paid resources as an incidental test.
3. Copy the exact redirect URI and CIMD/client details displayed by the real MCP connection management page. Current OpenAI docs allow a stable redirect for servers correctly advertising and returning issuer identification; other connections use callback-specific URIs. Do not guess either value.
4. Configure the four names above in an approved isolated environment whose provider/storage credentials cannot access production. Confirm deployed SHA and resource metadata before any generation test.
5. Verify actual account/workspace eligibility and register/connect through the supported ChatGPT flow. Separately exercise web, iOS and Codex. A local package, reachable HTTPS URL, or passed SDK test proves none of these steps.
6. Establish retention, revocation and refresh behavior with the provider. Offline JWT verification detects expiry and key removal after cache refresh; immediate single-token revocation is not implemented. No production enablement is implied by this PR.

## Rollback

Set `CHATGPT_MCP_ENABLED=false` in the specifically authorized environment. The new resource rejects calls; existing GPT Action routes and the operator MCP boundary remain independent. No schema migration, account change, credentials rotation, existing GPT deletion, or persistent-data reversal is required by this foundation. This procedure documents a future authorized action; the PR does not change production configuration.

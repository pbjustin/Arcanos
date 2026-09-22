# Connection foundation decision

Decision recorded 2026-09-22 before runtime implementation. Base:
`655cb56fc3912684a0dd7b7bfb735a841f3c4056` (fresh origin/main); no open
pull requests overlapped at discovery.

Mount a separate stateless Streamable HTTP resource at `/chatgpt/mcp`,
before the application's broad body parser. Use the existing MCP SDK and jose,
with a dedicated OAuth issuer/resource/scope configuration. Authenticate before
parsing and authorize again inside the tool handler. Disabled is the default;
incomplete configuration returns 503 only on this integration.

Valid Tutor calls reuse the existing deployment-wide public-provider budget
(including configured store readiness) in addition to local IP/principal limits.
Runtime unsafe conditions are rechecked before admission and execution. MCP
batches are rejected, so one charged request cannot fan out into many calls.
Discovery consumes no provider budget. These controls preserve checks normally
provided by the later application middleware despite the early parser boundary.

Expose only `arcanos_tutor` with one bounded prompt. Reuse the existing
ARCANOS:TUTOR query service and generic teaching prompts. This synchronous
pilot intentionally does not claim parity with the GPT HTTP wrapper's queued
jobs or optional conversation persistence. No continuation or job IDs are
exposed. Existing Action routes and operator MCP remain separately authenticated.

The service receives a server-only isolated execution policy: empty ambient
session context, no memory access, no optional Trinity persistence or self
improvement, redacted provider diagnostics and stateless provider requests.
HRC uses its existing sensitive-context evaluation (no shared cache or provider
store). Ordinary callers retain their existing defaults. No user argument can
select a module, policy, identity, role, scope, URL or session.

The Tutor service's 60-second aggregate deadline and HTTP disconnect propagate
through the existing request-abort context to provider stages. Results expose
only completed work. A standalone MCP `notifications/cancelled` sent on another
POST cannot find the original stateless server instance: cancellation is proven
for HTTP disconnect and aggregate timeout, not cross-request MCP notification
cancellation. No session registry is introduced to imply otherwise. Results expose
only answer and bounded public metadata; a missing-client mock is identified explicitly.
Unlike the ordinary Tutor fallback path, provider exceptions in isolated mode
return a fixed unavailable error rather than a substitute mock answer.
Credentials and internal audit traces are never tool output. This remains
external provider generation; provider billing/retention outside request
`store:false` is governed by existing provider settings, not proven here.

MCP transport sessions are unused. ARCANOS conversation ownership for OAuth
subjects is not implemented; hydration is unavailable even if a caller supplies
a transport session header. No deployment-wide memory permission is assigned.

The portable skill/package source is separate from connection registration.
Release packaging fails until a genuine registered integration and client
eligibility are reconciled. See [platform evidence](PLATFORM.md),
[authentication](AUTHENTICATION.md), and the [operation inventory](INVENTORY.md).

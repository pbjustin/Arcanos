# Sealed Tutor MCP preview

This PR #1508 follow-up adds a fixed Tutor mock to the contained native Railway
preview. Its starting revision is
`bd6876910cc088b25d511de8058e4ebc642126b3`. It supplements the separate
[backend end-to-end fixture](2026-09-22-e2e.md); it does not replace that test's
real authentication and generation-pipeline coverage.

## Contract and containment

The web preview admits `POST /chatgpt/mcp` through its existing closed-route,
credential-carrier, JSON media-type, content-encoding and 4 KiB request-body
guards. The pure fixture supports MCP initialization, the initialized
notification, tool discovery and one tool call. It negotiates protocol
`2025-03-26`, advertises only `arcanos_tutor`, and uses the canonical Tutor
input and output schemas from `packages/protocol`.

The sole successful prompt is `Sealed Tutor preview: explain one half.`.
Its fixed answer includes `metadata.generation: "mock"`,
`metadata.memory: "unavailable"` and `metadata.execution: "synchronous"`.
Unknown tools, arbitrary prompts, extra arguments, malformed envelopes and
batches cannot produce a successful tutoring result. Successful transport
responses carry the synthetic-preview header and the versioned Tutor proof
header `x-arcanos-preview-chatgpt-tutor-version: chatgpt-tutor-mock/v1` in the
[preview contract](../../../scripts/native-pr-preview-contract.mjs).
These markers identify the synthetic boundary; a body/media denial after path
admission can retain them. Success still requires the expected HTTP and MCP
result, canonical output and explicit mock generation metadata.

This resource has no account identity or OAuth flow. Authorization, cookies,
session headers and other credential carriers remain denied before JSON
parsing. It does not issue transport sessions, expose OAuth metadata or provide
streaming; the optional MCP SDK `GET /chatgpt/mcp` probe receives 405 with
`Allow: POST`. An explicit protocol-version header must match `2025-03-26`
and cannot be duplicated. The
[pure fixture](../../../src/shared/chatgpt/chatgptTutorPreviewFixture.ts)
does not import or execute the production Tutor service, JWT
verification, Trinity, HRC, provider transport, backend memory, database, queue
or active worker. Existing preview import and semantic guards still apply.
The worker remains passive; the hosted verifier checks denial of the Tutor
path on the worker separately.

## Local interoperability fixture

[`chatgpt-tutor-preview.integration.test.ts`](../../../tests/chatgpt-tutor-preview.integration.test.ts)
constructs the real contained preview application on an ephemeral loopback
listener and uses the actual MCP SDK HTTP client. It checks initialize,
initialized notification, list and call, canonical schemas, explicit mock
metadata, synthetic provenance and the absence of a transport session.
It also checks unsupported tools/inputs, malformed JSON, batches, pre-parser
credential rejection, body/media/encoding limits, and unavailable paths and
methods. Exact 4,096-byte input succeeds while 4,097 bytes are denied. Duplicate
protocol headers are sent as actual separate HTTP headers. Bounded reserved
MCP `_meta` objects are accepted and ignored, never treated as tool arguments
or returned as output.

No application or Tutor fixture function is mocked. The optional Notion edge
probe is replaced with a function that fails if invoked; fetch destinations
are restricted to the test listener. The suite introduces no credential
configuration and performs no live provider or database operation. Listener
and SDK-client cleanup are bounded.

Run with the pinned Node `24.18.1` / npm `11.16.0` toolchain:

```text
node scripts/run-jest.mjs --runTestsByPath tests/chatgpt-tutor-preview.integration.test.ts --runInBand --coverage=false
```

| Evidence | Status |
| --- | --- |
| Local real-SDK preview interoperability | PASS: 19 cases on Node 24.18.1 / npm 11.16.0 |
| Combined preview application, import-boundary, pure fixture and SDK regression | PASS: 427 tests across four Jest suites, including the 19 SDK cases |
| Bounded hosted-verifier fixtures | PASS: 22 Node tests, including 28 rejected response mutations |
| Type-check and full build | PASS |
| Full ESLint | PASS: zero errors; 76 existing warnings |
| Source/compiled preview import containment | PASS; pure Tutor fixture has its own semantic pin |
| Exact-head hosted preview verification | Not established by this local fixture |
| Real Tutor/OAuth/ChatGPT or live model behavior in the preview | Not exercised; outside this fixture's contract |

The supplemental PR-head verifier adds 18 Tutor cases to the prior
138-request plan, for 156 bounded requests. They include the MCP handshake and
fixed tool result, rejected inputs/credentials/paths, GET streaming denial,
worker-role Tutor denial and web/worker OAuth-metadata denial. The trusted
main verifier at `655cb56fc3912684a0dd7b7bfb735a841f3c4056` still runs the
138-request baseline until this change reaches main. Its successful status
alone does not establish the added Tutor cases; they require the reviewed
exact-head supplemental verifier against the same independently confirmed
preview hosts.

A successful local or hosted sealed fixture establishes synthetic MCP
interoperability and the named containment checks. It does not establish
registered integration eligibility, installed ChatGPT behavior, OAuth consent,
refresh, real user identity, live answer quality or production readiness.

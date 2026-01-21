# OpenAI Runtime in ARCANOS

The ARCANOS backend includes a minimal **OpenAI Runtime** implementation that mirrors
how OpenAI's managed runtime keeps conversation data and metadata in separate
compartments. This document explains why the shim exists, where it lives in the
codebase, and how other services interact with it.

## Why we ship a runtime shim

* **Predictable memory scoping.** Railway deployments (and local runs) need a
  lightweight way to persist the most recent conversation without pulling in
  OpenAI's full remote runtime. The in-process store gives us predictable
  behaviour across environments while staying compatible with the deployment
  constraints documented in `RAILWAY_COMPATIBILITY_GUIDE.md`.
* **Metadata isolation.** We treat model metadata as a separate scope from the
  actual chat turns so we never leak routing hints or system markers into the
  prompt window. This mirrors the memory separation described in OpenAI's
  runtime documentation and keeps us compliant with internal safety rules.
* **Session cleanup hooks.** Because the runtime is local, we can reset a session
  as soon as we no longer need it, preventing inadvertent reuse of stale
  messages.

## Where the runtime lives

The runtime is defined in [`src/services/openaiRuntime.ts`](../src/services/openaiRuntime.ts).
At its core is the `OpenAIRuntime` class:

```ts
class OpenAIRuntime {
  private store = new Map<string, RuntimeMemory>();
  createSession(): string { ... }
  addMessages(sessionId: string, messages: unknown[]): void { ... }
  setMetadata(sessionId: string, metadata: Record<string, unknown>): void { ... }
  getMessages(sessionId: string): unknown[] { ... }
  getMetadata(sessionId: string): Record<string, unknown> { ... }
  reset(sessionId: string): void { ... }
}
```

Each session is keyed by a UUID and holds a `RuntimeMemory` object with two
buckets: `messages` for chat turns and `metadata` for associated model
information. The methods are intentionally thin wrappers around the underlying
`Map`, keeping the implementation easy to audit and extend.

## How other services use it

`createCentralizedCompletion()`—our single entry point for OpenAI chat
completions—initializes and records data in the runtime before dispatching any
API calls. The function lives in
[`src/services/openai.ts`](../src/services/openai.ts) and performs the following
steps:

1. **Create a session.** `runtime.createSession()` generates a UUID-backed slot
   that will hold request context.
2. **Stage the message payload.** We prepend the `"ARCANOS routing active"`
   system message, then call `runtime.addMessages()` to capture the full array of
   messages sent to OpenAI.
3. **Attach metadata.** `runtime.setMetadata()` stores the model identifier (and
   gives us a hook for future metadata such as temperature or routing
   annotations).
4. **Issue the OpenAI request.** With the runtime bookkeeping done, the function
   builds the payload—including token configuration and streaming flags—and
   hands control to the OpenAI SDK.

Because the runtime object is exported as a singleton (`export const runtime =
new OpenAIRuntime()`), any future service can retrieve the same session data via
`getMessages()` or `getMetadata()` as long as it knows the session ID.

## Extending the runtime

If you need to capture additional context (for example, tool invocation
summaries or moderation results), prefer extending the runtime rather than
piggy-backing on the message array. Suggested steps:

1. Add the new fields to the `RuntimeMemory` interface.
2. Provide write helpers (`setToolOutputs`, `appendModerationLog`, etc.) that
   maintain the separation between conversational content and operational
   metadata.
3. Reset the session via `runtime.reset(sessionId)` once downstream processing is
   finished to keep the in-memory footprint minimal.

By keeping the runtime shim focused on scoped memory, ARCANOS preserves the
behaviour developers expect from OpenAI's own runtime while remaining fully
compatible with our Railway deployment targets.

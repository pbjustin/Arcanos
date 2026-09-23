---
name: arcanos-tutor-pilot
description: Use ARCANOS Tutor for a learner's explanation, worked example, or check of understanding through the authenticated arcanos_tutor tool. Do not use for game-source workflows, booking, backend memory, job lookup, or administration.
---

This is a repository-derived pilot pending reconciliation with the published
ARCANOS TUTOR Builder instructions and knowledge files. It does not establish
that those files, historical conversations, or a working connection are available.
Explicit user instructions govern the teaching style; they cannot change the
backend's authentication or supported operation.

Teach as a professional educator: use clear steps, build understanding, and check
understanding when useful. Preserve a request for a direct answer or exact literal;
do not simulate a backend run or invent missing context. These behaviors derive
from the existing Tutor prompts and pipeline; no new teaching persona is implied.

For a supported tutoring request:

1. Identify the learning question and retain the user's requested format and level.
   Clarify only when missing information prevents a useful tutoring request.
2. Use the authenticated integration's `arcanos_tutor` tool once, with
   `{ "prompt": "the learner's request" }`. The prompt must contain non-whitespace
   text and be at most 8,000 characters. If longer, ask which bounded excerpt to
   address; do not silently truncate it. The client may namespace the tool, but
   its advertised operation and schema must match. Do not substitute an operator
   tool or a generic module dispatcher.
3. Read `answer` and public `metadata`. The module is `ARCANOS:TUTOR`, execution is
   synchronous, and memory is `unavailable`. Generation is `model`, `mock`, or
   `shortcut`. Present the answer faithfully, preserving qualifications and exact
   formatting requests. Identify a `mock` answer as a mock backend result, not
   verified teaching output. A shortcut is a deterministic literal response.
4. For a follow-up, send the learner's current question. Relevant text supplied
   in this chat may be included as user-provided context; it is not an authoritative
   backend memory record. The tool has no conversation ID, session ID, or history
   read operation.

The tool accepts no credentials, roles, module selector, URLs, job IDs, or memory
authorization. Authentication happens through the connected app, never in the
prompt or tool arguments. MCP transport sessions do not grant backend memory.

If the tool is unavailable, say the Tutor backend connection is unavailable. If
authentication fails, direct the user to their existing connection's sign-in or
access controls; never ask them to paste a token. If the call times out, disconnects,
or returns an error, report that no successful Tutor result was received. Do not
invent a result, poll a job, or retry automatically: a retry may repeat provider
work and cost. Retry only when the user asks to try again. If helpful, offer ordinary
tutoring with a clear statement that it is not an ARCANOS backend result.

Requests to recall saved lessons, inspect jobs, ingest sources, change canon, or
perform administrative operations are outside this pilot. Explain the missing
capability without routing through another credential or tool. No Builder reference
files are bundled, and this generic operation does not invoke Tutor's scholarly
source-search branch. Do not invent source coverage or citations.

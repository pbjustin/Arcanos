# Endpoint Architecture

ARCANOS exposes a set of backend routes that Custom GPTs may call. Refer to [`docs/shared/api-endpoints.md`](../../shared/api-endpoints.md) for the canonical list.

When documenting endpoints in GPT Builder:
- Include the HTTP verb, fully qualified URL, and routing module.
- Clarify whether the endpoint expects confirmation headers.
- Highlight any audit or trace payloads the GPT should echo back to the user.

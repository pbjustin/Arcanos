# Pinned Memory & Task Library

This guide explains how to store important resources in the ARCANOS memory system using the new helper script.

## Script Usage

```bash
node utils/pin_memory_resource.js --label PROJECT_X --type task --file ./workflow.md
```

Options:
- `--label` (or `-l`): context label / container ID
- `--type` (or `-t`): `task`, `reference`, or `logic`
- `--file` (or `-f`): path to a file containing the content to store
- `--key` (or `-k`): optional custom memory key
- `--base` (or `-b`): base API URL (defaults to `http://localhost:8080` or `$ARCANOS_URL`)

The script sends the content to `/api/memory/save` with the `X-Container-Id` header and marks the entry as pinned. The data is stored as:

```json
{
  "pinned": true,
  "type": "task",
  "content": "...file contents..."
}
```

Retrieve stored entries with:

```bash
curl -H "X-Container-Id: PROJECT_X" http://localhost:8080/api/memory/all
```

## Example Workflow
1. Prepare a workflow file, e.g. `deploy.md`.
2. Pin it to memory:
   ```bash
   node utils/pin_memory_resource.js -l PROJECT_X -t task -f deploy.md
   ```
3. Verify storage with the retrieval command above.

This mechanism supports uploading task libraries, reference documents, and logic definitions for later use by ARCANOS.

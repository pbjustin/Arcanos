# ARCANOS Cross-Codebase Synchronization Guide

## Overview

ARCANOS consists of two codebases that must stay synchronized:
- **TypeScript Server** (`src/`) - Backend API service
- **Python Daemon** (`daemon-python/`) - Local client application

This guide explains how to keep both codebases in sync when making changes.

## Quick Start

### Run Sync Check
```bash
npm run sync:check
```

This will check:
- ✅ Dependency version alignment
- ✅ API contract compatibility
- ✅ Version number synchronization
- ✅ Environment variable alignment
- ✅ Test coverage balance
- ✅ Breaking change detection

### Watch Mode
```bash
npm run sync:watch
```

Monitors both codebases and alerts when sync issues are detected.

## Features

### 1. Dependency Synchronization

**Critical Dependencies** (must match major versions):
- OpenAI SDK: Python `openai>=1.12.0` ↔ Node `openai@^6.16.0`

**Related Dependencies** (should align):
- HTTP Clients: Python `requests` ↔ Node `axios`

**Check Dependencies:**
```bash
node scripts/sync-helper.js check-deps
```

### 2. API Contract Validation

Ensures Python client methods match TypeScript server routes.

**Supported Endpoints:**
- `/api/ask` - Chat completions
- `/api/vision` - Image analysis
- `/api/transcribe` - Audio transcription
- `/api/update` - Event updates
- `/api/auth/login` - Authentication

**Check Specific Endpoint:**
```bash
node scripts/sync-helper.js check-api /api/ask
```

### 3. Version Synchronization

Keep version numbers identical across both codebases.

**Sync Versions:**
```bash
node scripts/sync-helper.js sync-version 1.0.1
```

This updates:
- `package.json` (Node version)
- `daemon-python/config.py` (Python VERSION)

### 4. Environment Variable Alignment

Shared environment variables should have matching defaults.

**Check Environment Variables:**
```bash
node scripts/sync-helper.js check-env
```

**Shared Variables:**
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `OPENAI_VISION_MODEL` (default: `gpt-4o`)
- `TEMPERATURE` (default: `0.7`)
- `MAX_TOKENS` (default: `500`)
- `LOG_LEVEL` (default: `info`)

### 5. Breaking Change Detection

Automatically detects when server changes break client compatibility.

**What It Checks:**
- New API endpoints without client methods
- Changed request/response schemas
- Missing required fields
- Removed endpoints

### 6. Test Coverage Balance

Ensures tests exist on both sides for critical functionality.

## Workflow

### When Working on Python Daemon

1. **Make Changes** to `daemon-python/`
2. **Run Sync Check**: `npm run sync:check`
3. **System Checks**: Verifies daemon matches server (source of truth)
4. **Warns if Diverged**: Shows if daemon uses fields/routes server doesn't have
5. **Fix Issues**: Either update server to match, or remove daemon code that doesn't match
6. **Commit Changes**

### When Working on TypeScript Server

1. **Make Changes** to `src/`
2. **Run Sync Check**: `npm run sync:check`
3. **Fix Issues** if any are found
4. **Update Client** if API contracts changed
5. **Commit Changes**

## Common Scenarios

### Adding a New API Endpoint

1. **Create Server Route** in `src/routes/api-*.ts`
2. **Add Client Method** in `daemon-python/backend_client.py`
3. **Update API Contracts** in `scripts/sync-config.json`
4. **Run Sync Check**: `npm run sync:check`
5. **Add Tests** for both sides

### Updating a Dependency

1. **Update in One Codebase** (Python or Node)
2. **Check if Shared**: Run `npm run sync:check`
3. **Update Other Codebase** if needed
4. **Verify Compatibility**: Ensure major versions align
5. **Test Both Sides**

### Changing API Schema

1. **Update Server Route** with new schema
2. **Update Client Method** to match
3. **Run Sync Check**: `npm run sync:check`
4. **Fix Any Errors**
5. **Update Tests**

### Releasing New Version

1. **Sync Version**: `node scripts/sync-helper.js sync-version 1.0.1`
2. **Run Full Check**: `npm run sync:check`
3. **Run Tests**: `npm test`
4. **Update CHANGELOG.md**
5. **Commit and Tag**

## Configuration

Sync settings are in `scripts/sync-config.json`:

```json
{
  "sharedDependencies": { ... },
  "apiContracts": { ... },
  "sharedEnvVars": { ... },
  "versionFiles": { ... }
}
```

## Pre-Commit Hook

To automatically run sync checks before commits:

```bash
# Install pre-commit hook
cp scripts/pre-commit-sync-check.js .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Or use Git hooks manager:
```bash
npm install --save-dev husky
npx husky install
npx husky add .husky/pre-commit "npm run sync:check"
```

## Troubleshooting

### "Version mismatch" Error

**Solution:**
```bash
node scripts/sync-helper.js sync-version <version>
```

### "Missing API method" Error

**Solution:**
1. Check if endpoint exists in server
2. Add corresponding method to `backend_client.py`
3. Run sync check again

### "Dependency version mismatch" Error

**Solution:**
1. Check which codebase has newer version
2. Update the other codebase to match major version
3. Test both sides

### "Environment variable missing" Error

**Solution:**
1. Add variable to `.env.example` in missing codebase
2. Add default value if it's a shared variable
3. Update `sync-config.json` if needed

## Best Practices

1. **Run sync check before committing** - Catch issues early
2. **Keep versions aligned** - Use sync-version helper
3. **Update both sides together** - Don't leave one behind
4. **Test after sync** - Ensure both codebases work
5. **Document breaking changes** - Update CHANGELOG.md

## Integration with CI/CD

Add to your CI pipeline:

```yaml
# .github/workflows/sync-check.yml
name: Cross-Codebase Sync Check

on: [push, pull_request]

jobs:
  sync-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run sync:check
```

## Support

For issues or questions:
- Check `scripts/sync-config.json` for configuration
- Review `.cursorrules` for AI assistant guidance
- Run `npm run sync:check` for detailed diagnostics

---

**Remember**: The goal is seamless integration. When one side changes, the other should adapt automatically.

# Pass 1: Commit Proposal

## Title

Align docs to OpenAI SDK v6.16.0 and config defaults

## Body

### Why
Documentation contained outdated SDK version references (v6.15.0, v5.16.0) and configuration documentation that didn't match actual code behavior, creating potential confusion for developers.

### What
- Updated all SDK version references to v6.16.0 (matches `package.json`)
- Aligned `docs/CONFIGURATION.md` model selection order and default model with `credentialProvider.ts`
- Fixed incorrect file path references (`dist/index.js` → `dist/start-server.js`)

### Evidence
- `package.json`: `"openai": "^6.16.0"`
- `src/services/openai/credentialProvider.ts`: Model order and default `gpt-4o-mini`
- `package.json`: Start script uses `dist/start-server.js`

### Risk
**Low** - Documentation-only changes. No code modifications. All changes align documentation with existing codebase.

### Files Changed
- 10 documentation files updated
- 9 SDK version fixes
- 1 configuration alignment fix
- 2 file path corrections

## Tags

`docs`, `sdk`, `audit`, `accuracy`

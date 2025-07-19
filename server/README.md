# Legacy Server Implementation

⚠️ **DEPRECATED**: This directory contains a legacy server implementation that is no longer used.

## Current Entry Point
The current application entry point is located at:
- **Source**: `src/index.ts`
- **Compiled**: `dist/index.js` (built via `npm run build`)
- **Startup**: `npm start` (references `dist/index.js` via package.json)

## Audit Status
✅ **ARCANOS FULL AUDIT COMPLETED** - The main entry point (`src/index.ts`) includes:
- Express server with health endpoint
- Graceful shutdown logic (SIGTERM/SIGINT)
- OpenAI fine-tune safety wrapper with fallback handling
- Railway service configuration validation
- Comprehensive error handling

## Migration Notes
This legacy implementation has been superseded by the TypeScript implementation in `src/` which provides:
- Better type safety
- Enhanced error handling
- Railway deployment optimization
- OpenAI fine-tune integration with explicit fallback consent
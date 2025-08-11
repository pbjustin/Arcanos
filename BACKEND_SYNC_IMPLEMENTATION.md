# Backend Sync + GPT Integration Implementation

This implementation adds backend synchronization and GPT integration capabilities to the Arcanos system, as specified in the problem statement.

## Overview

The implementation provides:
- **System State Management**: Persistent state storage using JSON files
- **Status API Endpoints**: GET/POST `/status` routes for state read/write operations
- **GPT Integration with Backend Sync**: Automatic backend state synchronization for GPT calls
- **Seamless Integration**: Minimal changes to existing codebase structure

## Components Added

### 1. State Management Service (`src/services/stateManager.ts`)
```typescript
// Functions:
- loadState(): SystemState          // Load state from systemState.json
- updateState(data): SystemState    // Update and persist state 
- getBackendState(port): Promise<SystemState> // Fetch state via HTTP
```

### 2. Status Routes (`src/routes/status.ts`)
```typescript
// Endpoints:
GET  /status  // Retrieve current system state
POST /status  // Update system state with request body
```

### 3. GPT Sync Service (`src/services/gptSync.ts`)
```typescript
// Functions:
- askGPTWithSync(prompt, port, model): Promise<string>
- runSystemDiagnostic(port): Promise<string>
- askGPTWithContext(prompt, context, port, model): Promise<{response, backendState, context}>
```

### 4. Server Integration (`src/server.ts`)
- Added status router to Express app
- Automatic state initialization on startup
- Optional GPT diagnostic call after server start

## File Structure

```
src/
├── services/
│   ├── stateManager.ts       # NEW: State persistence & management
│   └── gptSync.ts           # NEW: GPT integration with backend sync
├── routes/
│   └── status.ts            # NEW: /status GET/POST endpoints
└── server.ts                # MODIFIED: Added status routes & startup logic
```

## Usage Examples

### 1. Basic State Management
```javascript
// Read current state
const response = await fetch('http://localhost:8080/status');
const state = await response.json();

// Update state
await fetch('http://localhost:8080/status', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'updated', customField: 'value' })
});
```

### 2. GPT Integration with Backend Sync
```javascript
import { askGPTWithSync } from './dist/services/gptSync.js';

// GPT call with automatic backend state sync
const response = await askGPTWithSync(
  "Run a system diagnostic and report the current backend state.",
  8080,  // server port
  "gpt-4" // model (optional)
);
```

### 3. Programmatic State Management
```javascript
import { loadState, updateState } from './dist/services/stateManager.js';

// Load current state
const currentState = loadState();

// Update state
const newState = updateState({
  status: 'processing',
  lastUpdate: new Date().toISOString()
});
```

## Key Features

### ✅ **State Persistence**
- Uses `systemState.json` file for persistent storage
- Automatic `lastSync` timestamp on all updates
- Graceful fallback for file read/write errors

### ✅ **Backend Synchronization**
- GPT calls automatically fetch latest backend state
- State injected as system prompt context
- HTTP-based state retrieval with fallback to file

### ✅ **Express Integration**
- Standard REST API endpoints for state management
- JSON request/response format
- Proper error handling and HTTP status codes

### ✅ **Minimal Changes**
- Zero breaking changes to existing codebase
- Additive implementation approach
- Optional features that fail gracefully

## Configuration

### Environment Variables
```bash
OPENAI_API_KEY=your_openai_api_key  # Required for GPT functionality
PORT=3000                           # Server port (optional, defaults to 3000)
```

### Default State Structure
```json
{
  "status": "unknown",
  "version": "0.0.0", 
  "lastSync": null
}
```

## Testing

Run the test suite:
```bash
npm run build
node test-backend-sync.js
```

Run the demo server:
```bash
node demo-backend-sync.js
```

## API Reference

### GET /status
**Description**: Retrieve current system state  
**Response**: JSON object with current state  
**Example**:
```bash
curl http://localhost:8080/status
```

### POST /status  
**Description**: Update system state  
**Body**: JSON object with state updates  
**Response**: Updated complete state  
**Example**:
```bash
curl -X POST -H "Content-Type: application/json" \
     -d '{"status":"updated","customField":"value"}' \
     http://localhost:8080/status
```

## Implementation Notes

- **TypeScript Compatibility**: All new code written in TypeScript
- **ES6 Modules**: Uses ES6 import/export syntax
- **Error Handling**: Comprehensive error handling with fallbacks
- **Logging**: Consistent logging format with existing codebase
- **Non-blocking**: GPT calls don't block server startup
- **Graceful Degradation**: Works without OpenAI API key (logs warnings)

This implementation fulfills all requirements from the problem statement while maintaining compatibility with the existing Arcanos codebase architecture.
# AI-Enhanced Service Dispatcher

This document describes the refactored AI-enhanced service dispatcher that implements AI-defined logic for service routing with fallback prevention.

## Overview

The dispatcher has been enhanced to:
- Use AI-defined logic for service routing
- Disable fallback to defaultWorker unless manually triggered
- Route memory and API services through AI-bound flows
- Provide manual override logic for emergency access
- Maintain compatibility with OpenAI SDK v5.11+

## New Components

### 1. Workers

#### Memory Worker (`src/workers/memoryWorker.ts`)
Handles memory-related operations:
- `store`: Store data in memory system
- `retrieve`: Retrieve data from memory system
- `delete`: Delete data from memory system
- `sync`: Synchronize memory across systems
- `snapshot`: Create memory snapshot for backup/analysis

#### API Worker (`src/workers/apiWorker.ts`)
Handles API request processing:
- `request`: Make API requests with retry logic
- `webhook`: Process incoming webhook data
- `proxy`: Proxy requests to other services
- `batch`: Process multiple API requests
- `monitor`: Monitor API health and connectivity

#### Default Worker (`src/workers/defaultWorker.ts`)
Fallback worker for unhandled tasks:
- Only accessible with manual override
- Logs warnings when used
- Provides basic task processing capabilities
- Should not be used in normal operation

### 2. AI Service Dispatcher (`src/services/ai-service-dispatcher.ts`)

Main dispatcher that implements the AI-enhanced routing logic:

```typescript
import dispatchService, { createManualOverrideTask, requiresAIRouting } from './services/ai-service-dispatcher';

// Dispatch a memory service task
const memoryTask = {
  service: 'memory',
  action: 'store',
  data: { key: 'test-key', value: 'test-value' }
};
const result = await dispatchService(memoryTask);

// Create manual override task
const overrideTask = createManualOverrideTask('memory', data, userId);
const overrideResult = await dispatchService(overrideTask);
```

### 3. Enhanced Main Dispatcher (`src/dispatcher.ts`)

The main dispatcher now supports:
- AI-bound service routing for memory and API services
- Fallback prevention with manual override
- Backward compatibility with existing routes

## API Usage

### Memory Service Routing

```javascript
// POST to dispatcher endpoint
{
  "service": "memory",
  "action": "store",
  "data": {
    "key": "user-preferences",
    "value": { "theme": "dark", "language": "en" }
  }
}
```

### API Service Routing

```javascript
// POST to dispatcher endpoint
{
  "service": "api",
  "action": "request",
  "data": {
    "method": "GET",
    "url": "https://api.example.com/data",
    "headers": { "Authorization": "Bearer token" }
  }
}
```

### Manual Override (Emergency Access)

```javascript
// POST to dispatcher endpoint
{
  "service": "memory",
  "worker": "defaultWorker",
  "manualOverride": true,
  "action": "process",
  "data": { "emergency": "data" }
}
```

## Fallback Prevention

The system now prevents automatic fallback to defaultWorker:

1. **Disabled by default**: Any attempt to use defaultWorker without manual override will result in an error
2. **Manual override required**: Must explicitly set `manualOverride: true` to use defaultWorker
3. **Warning logs**: Manual override usage is logged with warnings
4. **Error responses**: Returns status 400 with clear error message when fallback is attempted

## AI Integration

### Service Routing
- Memory and API services are automatically routed through AI decision making
- AI analyzes request context and determines optimal worker assignment
- Fallback to direct routing if AI is unavailable

### Bypass Options
- Use `bypassAI: true` to skip AI routing and use direct worker assignment
- Useful for testing or when AI service is unavailable

## OpenAI SDK Compatibility

- Compatible with OpenAI SDK v5.11+
- Uses latest chat completion API patterns
- Supports fine-tuned models and function calling
- Includes proper error handling and retry logic

## Error Handling

The dispatcher provides comprehensive error handling:

```javascript
{
  "success": false,
  "error": "Fallback to defaultWorker is disabled. Define a specific worker.",
  "service": "memory"
}
```

## Backward Compatibility

Existing routes continue to work:
- `type: 'codex'` → Codex handler
- `type: 'audit'` → Audit handler  
- `type: 'diagnostic'` → Diagnostic handler
- Default logic handler for unspecified types

## Migration Guide

### From Old Dispatcher
1. Update service calls to use new `service` parameter
2. Replace worker assignments with AI-bound routing
3. Add manual override logic for emergency access
4. Update error handling for fallback prevention

### Testing
Run the test suite to verify functionality:
```bash
npx ts-node test-ai-service-dispatcher.ts
npx ts-node test-dispatcher-integration.ts
```

## Security Considerations

1. **Fallback Prevention**: Prevents accidental use of generic fallback worker
2. **Manual Override Logging**: All override usage is logged with warnings
3. **AI Authorization**: AI decisions are validated before execution
4. **Worker Isolation**: Each worker has specific interfaces and validation

## Performance

- AI routing adds minimal latency (~100-200ms)
- Direct routing available for performance-critical paths
- Worker-specific optimizations for memory and API operations
- Caching and retry logic for reliability
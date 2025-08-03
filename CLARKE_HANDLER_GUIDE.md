# ClarkeHandler Implementation Guide

## Overview

The ClarkeHandler provides a resilient OpenAI wrapper with automatic retries, fallback mechanisms, and global initialization management. This implementation transforms the simple OpenAI usage pattern into an enterprise-grade resilient handler.

## Pattern Transformation

### Old Code
```typescript
let handler = new OpenAI.ClarkeHandler({ ...process.env });
handler.initialzeResilience({ retries: 3 });
```

### Patched Code
```typescript
if (!global.resilienceHandlerInitialized) {
  let handler = new OpenAI.ClarkeHandler({ ...process.env });
  handler.initialzeResilience({ retries: 3 });
  handler.fallbackTo(genericFallback());
  global.resilienceHandlerInitialized = true;
}
```

## Key Features

1. **Global Initialization Check**: Prevents duplicate handler setup using `global.resilienceHandlerInitialized`
2. **Resilience Configuration**: Configurable retry logic with exponential backoff
3. **Fallback Integration**: Seamless integration with existing GPT4FallbackService
4. **Error Handling**: Intelligent retry logic that avoids retrying on certain errors (invalid API key, quota exceeded)

## Usage

### Basic Usage
```typescript
import './services/clarke-handler';
import { genericFallback } from './services/clarke-handler';

// Initialize with global pattern
if (!global.resilienceHandlerInitialized) {
  let handler = new OpenAI.ClarkeHandler({ ...process.env });
  handler.initialzeResilience({ retries: 3 });
  handler.fallbackTo(genericFallback());
  global.resilienceHandlerInitialized = true;
}
```

### Using the Helper Functions
```typescript
import { getResilienceHandler } from './resilience-handler-example';

const handler = getResilienceHandler();
const result = await handler.chat([
  { role: 'user', content: 'Your message here' }
]);
```

## Configuration Options

### ResilienceOptions
```typescript
interface ResilienceOptions {
  retries: number;                // Number of retry attempts
  backoffMultiplier?: number;     // Exponential backoff multiplier (default: 2)
  maxBackoffMs?: number;          // Maximum backoff delay (default: 30000)
  timeoutMs?: number;             // Request timeout (default: 60000)
}
```

## Integration with Existing Code

The implementation is designed to be a drop-in replacement for existing OpenAI usage. Example integration:

```typescript
// Before
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// After
import './services/clarke-handler';
import { genericFallback } from './services/clarke-handler';

let openai: ClarkeHandler;
if (!global.resilienceHandlerInitialized) {
  let handler = new OpenAI.ClarkeHandler({ ...process.env });
  handler.initialzeResilience({ retries: 3 });
  handler.fallbackTo(genericFallback());
  global.resilienceHandlerInitialized = true;
  openai = handler;
} else {
  openai = new OpenAI.ClarkeHandler({ ...process.env });
  openai.initialzeResilience({ retries: 3 });
  openai.fallbackTo(genericFallback());
}
```

## Files Created/Modified

1. **src/services/clarke-handler.ts** - Main ClarkeHandler implementation
2. **src/resilience-handler-example.ts** - Usage examples and helper functions
3. **src/handlers/generic-handler.ts** - Updated to use ClarkeHandler pattern
4. **test-clarke-handler.ts** - Test suite verifying functionality

## Testing

Run the test suite to verify functionality:
```bash
npx ts-node test-clarke-handler.ts
```

The test verifies:
- Global initialization pattern
- Method availability
- Error handling and fallback mechanisms
- Integration with existing services

## Error Handling

The ClarkeHandler provides multiple layers of error handling:

1. **Automatic Retries**: Configurable retry attempts with exponential backoff
2. **Smart Error Detection**: Avoids retrying on permanent errors (invalid API key, quota exceeded)
3. **Fallback Mechanism**: Integrates with GPT4FallbackService for graceful degradation
4. **Comprehensive Logging**: Detailed logging for debugging and monitoring

## Best Practices

1. Always use the global initialization pattern to prevent duplicate handlers
2. Configure appropriate retry counts based on your use case
3. Monitor fallback usage to identify potential issues
4. Use the helper functions in production for consistent behavior
5. Test with mock API keys to verify error handling behavior
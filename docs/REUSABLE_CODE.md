# Reusable Code Utilities Documentation

This document describes the reusable utility modules created for both TypeScript and Python codebases, following OpenAI SDK best practices and Railway-native patterns.

## Overview

The codebase has been streamlined with reusable utilities that provide:
- Consistent OpenAI SDK usage patterns
- Railway-native configuration and deployment
- Unified error handling and retry logic
- Standardized health checks and telemetry
- Cross-language pattern alignment (TypeScript ↔ Python)

## TypeScript Utilities

### OpenAI Client Wrapper

**Location**: `src/services/openai/unifiedClient.ts`

Provides consistent OpenAI client initialization with Railway-native credential resolution.

**Key Functions**:
- `createOpenAIClient(options?)` - Create a new client instance
- `getOrCreateClient()` - Get or create singleton client
- `validateClientHealth()` - Comprehensive health check
- `resetClient()` - Reset singleton for testing

**Usage**:
```typescript
import { getOrCreateClient } from './services/openai/unifiedClient.js';

const client = getOrCreateClient();
if (!client) {
  // Handle missing API key
}
```

### Error Handling Utilities

**Location**: `src/lib/errors/reusable.ts`

Provides consistent error classification and retry eligibility determination.

**Key Functions**:
- `classifyOpenAIError(error)` - Classify error type and retry eligibility
- `isRetryableError(error)` - Quick retry check
- `getRetryDelay(error, attempt)` - Calculate retry delay with backoff
- `formatErrorMessage(error)` - User-friendly error messages

**Usage**:
```typescript
import { classifyOpenAIError, shouldRetry } from './lib/errors/reusable.js';

try {
  // OpenAI API call
} catch (error) {
  const classification = classifyOpenAIError(error);
  if (shouldRetry(error, attempt, maxRetries)) {
    // Retry logic
  }
}
```

### Retry/Resilience Module

**Location**: `src/utils/resilience/unifiedRetry.ts`

Provides unified retry logic for any async operation.

**Key Functions**:
- `withRetry(operation, options)` - Execute with retry logic
- `createRetryStrategy(config)` - Create custom retry strategy
- `calculateBackoff(attempt, error?)` - Calculate backoff delay

**Usage**:
```typescript
import { withRetry } from './utils/resilience/unifiedRetry.js';

const result = await withRetry(
  async () => {
    return await someOperation();
  },
  {
    maxRetries: 3,
    operationName: 'myOperation',
    useCircuitBreaker: true
  }
);
```

### Request Builders

**Location**: `src/services/openai/requestBuilders.ts`

Standardized request builders for all OpenAI API operations.

**Key Functions**:
- `buildChatCompletionRequest(params)` - Chat completions
- `buildVisionRequest(params)` - Vision requests
- `buildTranscriptionRequest(params)` - Audio transcription
- `buildImageRequest(params)` - Image generation
- `buildEmbeddingRequest(params)` - Embeddings

**Usage**:
```typescript
import { buildChatCompletionRequest } from './services/openai/requestBuilders.js';

const request = buildChatCompletionRequest({
  prompt: "Hello",
  systemPrompt: "You are a helpful assistant",
  model: "gpt-4o",
  maxTokens: 1000
});
```

### Configuration Module

**Location**: `src/config/unifiedConfig.ts`

Centralized configuration with Railway fallbacks.

**Key Functions**:
- `getConfig()` - Get unified configuration
- `validateConfig()` - Validate configuration
- `getEnvVar(key, fallbacks?)` - Resolve env var with fallbacks
- `isRailwayEnvironment()` - Check if running on Railway

**Usage**:
```typescript
import { getConfig, validateConfig } from './config/unifiedConfig.js';

const config = getConfig();
const validation = validateConfig();
if (!validation.valid) {
  // Handle validation errors
}
```

### Health Check Utilities

**Location**: `src/utils/health/unifiedHealth.ts`

Reusable health check patterns for Railway deployments.

**Key Functions**:
- `createHealthCheck(name, check, critical?)` - Create health check
- `aggregateHealthChecks(checks)` - Aggregate multiple checks
- `buildHealthEndpoint(checks)` - Build Express endpoint
- `buildLivenessEndpoint()` - Liveness probe endpoint
- `buildReadinessEndpoint(checks)` - Readiness probe endpoint

**Usage**:
```typescript
import {
  createHealthCheck,
  buildHealthEndpoint,
  checkOpenAIHealth,
  checkDatabaseHealth
} from './utils/health/unifiedHealth.js';

const healthEndpoint = buildHealthEndpoint([
  createHealthCheck('openai', checkOpenAIHealth, true),
  createHealthCheck('database', checkDatabaseHealth, false)
]);

router.get('/health', healthEndpoint);
```

### Telemetry Utilities

**Location**: `src/utils/telemetry/unifiedTelemetry.ts`

Railway-native telemetry patterns for tracing and metrics.

**Key Functions**:
- `traceOperation(name, operation)` - Trace async operation
- `recordMetric(name, value, tags?)` - Record metric
- `createSpan(name)` - Create tracing span
- `logRailway(level, message, metadata?)` - Railway-compatible logging

**Usage**:
```typescript
import { traceOperation, recordMetric } from './utils/telemetry/unifiedTelemetry.js';

const result = await traceOperation('myOperation', async () => {
  return await performOperation();
});

recordMetric('operation.count', 1, { operation: 'myOperation' });
```

## Python Utilities

### Unified OpenAI Client

**Location**: `daemon-python/arcanos/openai/unified_client.py`

Python equivalent of TypeScript unified client wrapper.

**Key Functions**:
- `create_openai_client(options?)` - Create client instance
- `get_or_create_client()` - Get or create singleton
- `validate_client_health()` - Health check
- `reset_client()` - Reset singleton

**Usage**:
```python
from arcanos.openai.unified_client import get_or_create_client

client = get_or_create_client()
if not client:
    # Handle missing API key
```

### Error Handling Utilities

**Location**: `daemon-python/arcanos/utils/error_handling.py`

Python error handling matching TypeScript patterns.

**Key Functions**:
- `classify_openai_error(error)` - Classify error
- `is_retryable_error(error)` - Check retry eligibility
- `get_retry_delay(error, attempt)` - Calculate delay
- `format_error_message(error)` - User-friendly messages

**Usage**:
```python
from arcanos.utils.error_handling import classify_openai_error, should_retry

try:
    # OpenAI API call
except Exception as error:
    classification = classify_openai_error(error)
    if should_retry(error, attempt, max_retries):
        # Retry logic
```

### Retry/Resilience Module

**Location**: `daemon-python/arcanos/utils/retry.py`

Python retry logic matching TypeScript patterns.

**Key Functions**:
- `with_retry(operation, options)` - Execute with retry
- `retry_with_backoff(...)` - Decorator for retry
- `calculate_backoff(attempt, error?)` - Calculate delay

**Usage**:
```python
from arcanos.utils.retry import with_retry, RetryOptions

result = with_retry(
    lambda: some_operation(),
    RetryOptions(max_retries=3, operation_name='myOperation')
)
```

### Request Builders

**Location**: `daemon-python/arcanos/openai/request_builders.py`

Python request builders matching TypeScript patterns.

**Key Functions**:
- `build_chat_completion_request(...)` - Chat completions
- `build_vision_request(...)` - Vision requests
- `build_transcription_request(...)` - Audio transcription
- `build_image_request(...)` - Image generation

**Usage**:
```python
from arcanos.openai.request_builders import build_chat_completion_request

request = build_chat_completion_request(
    prompt="Hello",
    system_prompt="You are helpful",
    model="gpt-4o",
    max_tokens=1000
)
```

### Configuration Utilities

**Location**: `daemon-python/arcanos/utils/config.py`

Python configuration utilities with Railway fallbacks.

**Key Functions**:
- `get_env_var(key, fallbacks?)` - Resolve env var
- `is_railway_environment()` - Check Railway
- `get_config()` - Get unified config
- `validate_config()` - Validate config

**Usage**:
```python
from arcanos.utils.config import get_config, validate_config

config = get_config()
validation = validate_config()
if not validation['valid']:
    # Handle validation errors
```

### Health Check Utilities

**Location**: `daemon-python/arcanos/utils/health.py`

Python health check utilities matching TypeScript patterns.

**Key Functions**:
- `create_health_check(name, check, critical?)` - Create check
- `aggregate_health_checks(checks)` - Aggregate checks
- `check_openai_health()` - OpenAI health check
- `build_health_response(checks)` - Build response

**Usage**:
```python
from arcanos.utils.health import (
    create_health_check,
    check_openai_health,
    build_health_response
)

checks = [
    create_health_check('openai', check_openai_health, True)
]
response = build_health_response(checks)
```

### Telemetry Utilities

**Location**: `daemon-python/arcanos/utils/telemetry.py`

Python telemetry utilities matching TypeScript patterns.

**Key Functions**:
- `record_trace_event(name, attributes?)` - Record trace
- `trace_operation(name, operation)` - Trace operation
- `record_metric(name, value, tags?)` - Record metric
- `log_railway(level, message, metadata?)` - Railway logging

**Usage**:
```python
from arcanos.utils.telemetry import trace_operation, record_metric

result = trace_operation('myOperation', lambda: perform_operation())
record_metric('operation.count', 1, {'operation': 'myOperation'})
```

## Cross-Language Alignment

All utilities follow consistent patterns across TypeScript and Python:

1. **Error Messages**: Aligned between languages
2. **Retry Strategies**: Same backoff calculations
3. **Health Checks**: Compatible response formats
4. **Telemetry**: Unified event names and structures
5. **Configuration**: Matching resolution patterns
6. **Logging**: Consistent formats and levels

## Railway-Native Patterns

All utilities follow Railway best practices:

- **Stateless**: No local state dependencies
- **Deterministic**: Same inputs = same outputs
- **Environment Variables**: Railway fallbacks built-in
- **Health Checks**: Railway-compatible endpoints
- **Logging**: Structured JSON for Railway aggregation

## Migration Guide

### From Old Patterns to New Utilities

#### OpenAI Client Creation

**Before**:
```typescript
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

**After**:
```typescript
import { getOrCreateClient } from './services/openai/unifiedClient.js';
const client = getOrCreateClient();
```

#### Error Handling

**Before**:
```typescript
catch (error) {
  if (error.status === 429) {
    // retry logic
  }
}
```

**After**:
```typescript
import { classifyOpenAIError, shouldRetry } from './lib/errors/reusable.js';
catch (error) {
  if (shouldRetry(error, attempt, maxRetries)) {
    // retry logic
  }
}
```

#### Retry Logic

**Before**:
```typescript
for (let i = 0; i < 3; i++) {
  try {
    return await operation();
  } catch (error) {
    await sleep(1000 * Math.pow(2, i));
  }
}
```

**After**:
```typescript
import { withRetry } from './utils/resilience/unifiedRetry.js';
const result = await withRetry(
  () => operation(),
  { maxRetries: 3, operationName: 'operation' }
);
```

## Best Practices

1. **Always use unified utilities** - Don't create OpenAI clients directly
2. **Use request builders** - Standardize all OpenAI requests
3. **Leverage error handling** - Use classification for consistent behavior
4. **Enable telemetry** - Track operations for observability
5. **Validate configuration** - Check config at startup
6. **Health checks** - Use unified health utilities for endpoints

## Testing

All utilities are designed to be testable:

- Mock-friendly interfaces
- Dependency injection support
- Clear separation of concerns
- Railway environment detection for testing

## Future Enhancements

- Additional request builder patterns
- Enhanced circuit breaker integration
- More comprehensive health checks
- Extended telemetry capabilities
- Performance optimizations

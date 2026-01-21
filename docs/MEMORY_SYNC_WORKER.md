# Memory Sync Worker Documentation

## Overview

The Memory Sync Worker is a TypeScript-based worker that synchronizes in-memory state to a persistent store with optional OpenAI embedding support.

## Architecture

### Directory Structure

```
workers/src/
├── infrastructure/
│   ├── sdk/
│   │   └── openai.ts          # OpenAI SDK wrapper with lazy initialization
│   └── memory/
│       └── index.ts            # MemoryStore implementation
├── workers/
│   └── memorySync-worker.ts    # Worker entry point
├── handlers/
│   └── memorySync.ts           # Handler implementation
└── jobs/
    └── index.ts                # Job type definitions
```

## Features

- **Memory Persistence**: Stores key-value pairs in a persistent memory store
- **OpenAI Embeddings**: Optional embedding generation for stored values
- **Error Handling**: Comprehensive error handling with retry support
- **TypeScript**: Fully typed with TypeScript for type safety
- **Rollback Support**: Ability to rollback operations

## Usage

### Starting the Worker

```bash
npm run start:memorySync
```

### Using the Worker Programmatically

```typescript
import { TypedWorkerQueue } from './workers/src/queue/index.js';
import { memorySyncHandler } from './workers/src/handlers/memorySync.js';

const queue = new TypedWorkerQueue();
queue.register('MEMORY_SYNC', memorySyncHandler);

// Sync data without embedding
const result = await queue.dispatch('MEMORY_SYNC', {
  key: 'user-preferences',
  value: { theme: 'dark', language: 'en' }
});

// Sync data with OpenAI embedding
const resultWithEmbedding = await queue.dispatch('MEMORY_SYNC', {
  key: 'document-content',
  value: 'This is a sample document text',
  embed: true
});
```

### Environment Variables

The worker supports environment-based execution:

```bash
WORKER_JOB=MEMORY_SYNC WORKER_PAYLOAD='{"key":"test","value":"data"}' node dist/workers/memorySync-worker.js
```

## Infrastructure Components

### OpenAI SDK Wrapper

The OpenAI SDK wrapper provides lazy initialization to avoid requiring API keys at module load time:

```typescript
import openai from './infrastructure/sdk/openai.js';

// Use the client
const embedding = await openai.embeddings.create({
  model: 'text-embedding-ada-002',
  input: 'text to embed'
});
```

### MemoryStore

The MemoryStore provides a simple key-value store interface:

```typescript
import { MemoryStore } from './infrastructure/memory/index.js';

// Store a value
await MemoryStore.set('key', { data: 'value' });

// Retrieve a value
const value = await MemoryStore.get('key');

// Delete a value
await MemoryStore.delete('key');

// Check existence
const exists = await MemoryStore.has('key');
```

## Job Type

The `MEMORY_SYNC` job type is defined as:

```typescript
type MemorySyncJob = {
  type: 'MEMORY_SYNC';
  payload: {
    key: string;        // Memory key to sync
    value: unknown;     // Value to persist (any JSON-serializable data)
    embed?: boolean;    // Optional: trigger OpenAI embedding flow
  };
};
```

## Return Value

The handler returns:

```typescript
{
  status: 'success',  // Operation status
  key: string        // The key that was synced
}
```

## Error Handling

The worker implements comprehensive error handling:

- Errors are logged with descriptive messages
- Errors are re-thrown to allow the queue supervisor to handle retries
- Retry logic is handled by the `TypedWorkerQueue` with configurable attempts and backoff

## Rollback Support

The handler exports a `rollback` function for undoing operations:

```typescript
import { rollback } from './handlers/memorySync.js';

await rollback({ key: 'user-preferences' });
```

## Testing

Run the tests:

```bash
npm test -- tests/memorySync-worker.test.ts
```

The test suite covers:
- Basic data synchronization
- Complex object synchronization
- Retry behavior on transient errors

## Integration with ARCANOS

The Memory Sync Worker integrates with the ARCANOS queue system and can be used for:
- Session state persistence
- Memory snapshot creation during sleep windows
- Embedding generation for semantic search
- Background data synchronization

## Configuration

The worker uses the following configuration:

- **OpenAI Model**: Configurable via `EMBEDDING_MODEL` environment variable (default: `text-embedding-3-large`)
- **OpenAI API Key**: Required via `OPENAI_API_KEY` environment variable
- **Retry Attempts**: Configurable via queue dispatch options (default: 3)
- **Backoff Strategy**: Exponential backoff (configurable)

### Environment Variables

- `OPENAI_API_KEY`: Required. OpenAI API key for embedding generation
- `EMBEDDING_MODEL`: Optional. Model to use for embeddings (default: `text-embedding-3-large`)
- `WORKER_JOB`: Job type for environment-based execution
- `WORKER_PAYLOAD`: JSON payload for environment-based execution

## Build

Build the worker:

```bash
npm run build:workers
```

This compiles TypeScript to JavaScript in the `workers/dist` directory.

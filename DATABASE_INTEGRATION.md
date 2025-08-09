# ARCANOS Database Integration

This document describes the database integration implemented for ARCANOS workers.

## Overview

The ARCANOS backend now supports PostgreSQL database integration for persistent storage of worker data, execution logs, and GPT-5 reasoning results. The implementation provides graceful fallback to in-memory/console logging when a database is not available.

## Database Module (`src/db.ts`)

### Features
- **Connection Pool Management**: Uses `pg` (node-postgres) library with connection pooling
- **Graceful Fallback**: Works without DATABASE_URL by logging to console and using in-memory storage
- **Type Safety**: Full TypeScript support with proper type definitions
- **Error Handling**: Comprehensive error handling with detailed logging

### Database Tables
- `memory`: Persistent worker memory storage (key-value with JSONB)
- `execution_logs`: Worker execution logs with metadata
- `job_data`: Worker job tracking and status
- `reasoning_logs`: GPT-5 reasoning results with input/output/metadata

### Core Functions
- `initializeDatabase()`: Initializes connection pool and creates tables
- `saveMemory()`, `loadMemory()`, `deleteMemory()`: Memory management
- `logExecution()`: Worker execution logging
- `createJob()`, `updateJob()`: Job management
- `logReasoning()`: GPT-5 reasoning logging
- `getStatus()`: Connection status check

## Workers (`workers/` directory)

### Worker Types
1. **worker-logger.js**: Centralized logging with database storage
2. **worker-memory.js**: Persistent memory management
3. **worker-gpt5-reasoning.js**: GPT-5 reasoning with result logging
4. **worker-planner-engine.js**: Job scheduling and management

### Worker Features
- **Database Integration**: All workers use the centralized db module
- **Fallback Behavior**: Continue operating without database
- **Logging**: Comprehensive logging of operations and status
- **Error Handling**: Graceful error handling with console fallbacks

## API Endpoints

### Memory Management
- `GET /memory/health`: Database connection status
- `POST /memory/save`: Store key-value data
- `GET /memory/load?key=<key>`: Retrieve stored data
- `GET /memory/list`: List recent memory entries
- `DELETE /memory/delete`: Remove stored data

### Response Examples

**Health Check (No Database)**:
```json
{
  "database": false,
  "error": null,
  "timestamp": "2025-08-09T13:55:34.067Z"
}
```

**Save Memory (No Database)**:
```json
{
  "error": "Failed to save memory",
  "details": "Database not configured"
}
```

## Configuration

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string (optional)
- `RUN_WORKERS`: Enable/disable worker initialization (default: true)

### Database URL Format
```
postgresql://username:password@hostname:port/database
```

Example:
```
DATABASE_URL=postgresql://arcanos:password@localhost:5432/arcanos
```

## Boot Sequence

1. **Database Initialization**: Attempts to connect to PostgreSQL if DATABASE_URL is set
2. **Table Creation**: Creates required tables if they don't exist
3. **Worker Initialization**: Starts all workers with database awareness
4. **Fallback Setup**: Configures console/memory fallbacks for workers without database
5. **Status Logging**: Reports database and worker status during boot

## Graceful Fallback Behavior

When `DATABASE_URL` is not set or connection fails:
- Workers continue to operate normally
- Memory operations fall back to in-memory Map storage
- Execution logs go to console output
- Reasoning logs go to console output
- Job scheduling is disabled (requires database)
- No errors or crashes occur

## Testing

The implementation includes comprehensive testing:
- Database connection logic validation
- Graceful fallback behavior verification
- Memory API endpoint testing
- Worker initialization testing
- Error handling validation

## Production Deployment

For production use:
1. Set up PostgreSQL database
2. Configure DATABASE_URL environment variable
3. Ensure database connectivity from ARCANOS instance
4. Monitor worker initialization logs for database status
5. Workers will automatically use database features when available

## OpenAI SDK Compatibility

All OpenAI API calls follow OpenAI SDK v4+ standards:
- Uses official `openai` package (v5.12.2+)
- Proper error handling and response parsing
- Compatible with GPT-5 model when available
- Fallback to GPT-4o for reasoning tasks
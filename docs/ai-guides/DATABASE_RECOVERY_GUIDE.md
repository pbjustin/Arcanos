# Database Recovery Handling Guide

## Overview

This document describes how the ARCANOS backend handles PostgreSQL database recovery scenarios, such as the one shown in the system logs where PostgreSQL performs automatic recovery after an improper shutdown.

## PostgreSQL Recovery Scenario

When PostgreSQL starts up after an improper shutdown, it performs Write-Ahead Log (WAL) recovery:

```
2025-07-21 09:49:28.413 UTC [29] LOG:  database system was interrupted; last known up at 2025-07-21 09:46:00 UTC
2025-07-21 09:49:28.447 UTC [29] LOG:  database system was not properly shut down; automatic recovery in progress
2025-07-21 09:49:28.455 UTC [29] LOG:  redo starts at 0/1979FE8
2025-07-21 09:49:28.455 UTC [29] LOG:  redo done at 0/1979FE8
2025-07-21 09:49:28.506 UTC [6] LOG:  database system is ready to accept connections
```

## Application Recovery Handling

### 1. Connection Retry Logic

The `DatabaseService` class implements exponential backoff retry logic:

- **Initial retry delay**: 2 seconds
- **Maximum retries**: 5 attempts
- **Backoff strategy**: Exponential (2s, 4s, 8s, 16s, 32s)
- **Recovery detection**: Identifies recovery-related error messages

### 2. Error Detection

The application detects database recovery scenarios by checking for these error patterns:

- `recovery` in error message
- `starting up` in error message
- `not ready` in error message
- `connection terminated`
- `server closed the connection`
- `ECONNRESET` error codes
- `ECONNREFUSED` error codes

### 3. Graceful Degradation

When the database is unavailable:

- **Core API remains functional**: GET `/`, POST `/ask` continue to work
- **Memory operations fail gracefully**: Return meaningful error messages
- **Health checks indicate status**: Show `degraded`, `recovering`, or `healthy`
- **Automatic reconnection**: Attempts to reconnect when database becomes available

### 4. Health Monitoring

The `/api/memory/health` endpoint provides real-time database status:

```json
{
  "service": "arcanos-memory",
  "status": "recovering",
  "database": false,
  "timestamp": "2025-07-21T09:49:30.000Z",
  "recovery": true
}
```

Status values:
- `healthy`: Database connected and operational
- `degraded`: No database configured (fallback mode)
- `recovering`: Database is in recovery mode
- `unhealthy`: Database connection failed

## Testing Recovery Scenarios

Use the included test script to validate recovery handling:

```bash
./test-database-recovery.js
```

This test verifies:
- Health status reporting
- Graceful error handling during recovery
- API resilience
- Meaningful error messages

## Configuration

### Environment Variables

- `DATABASE_URL`: PostgreSQL connection string
- `NODE_ENV`: Environment mode (affects SSL settings)

### Connection Pool Settings

- **Max connections**: 10
- **Idle timeout**: 30 seconds
- **Connection timeout**: 5 seconds (increased for recovery scenarios)

## Best Practices

1. **Monitor health endpoint**: Use `/api/memory/health` for monitoring
2. **Handle recovery errors**: Check for recovery-specific error messages
3. **Implement client retry**: Applications should retry failed database operations
4. **Use graceful degradation**: Core functionality should remain available

## Recovery Timeline

Typical recovery sequence:

1. **Database starts recovery** (0-10 seconds)
2. **Application detects connection failure** (immediate)
3. **Application enters degraded mode** (immediate)
4. **Database completes recovery** (varies)
5. **Application reconnects** (within 2-32 seconds)
6. **Normal operations resume** (immediate)

## Monitoring and Alerts

Monitor these metrics:
- Database connection status
- Recovery error frequency
- Application uptime during database issues
- Memory operation success rates

The application logs all recovery-related events for debugging and monitoring purposes.
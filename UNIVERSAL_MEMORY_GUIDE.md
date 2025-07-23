# 🧠 ARCANOS Universal Memory Archetype

## Overview
The Universal Memory Archetype is a standardized, Railway-compatible memory system for persistent state storage across containers and services in the ARCANOS ecosystem.

## Features
- ✅ PostgreSQL backend with automatic schema management
- ✅ Container isolation with scoped memory spaces
- ✅ REST API endpoints for memory operations
- ✅ Railway deployment ready
- ✅ Graceful degradation when database is unavailable
- ✅ Health check endpoints for monitoring

## API Endpoints

### Core Memory Operations

#### Save Memory
```http
POST /api/memory/save
Content-Type: application/json
X-Container-Id: optional-container-name

{
  "memory_key": "user_preference",
  "memory_value": { "theme": "dark", "language": "en" }
}
```

#### Load Memory
```http
GET /api/memory/load?key=user_preference
X-Container-Id: optional-container-name
```

#### Load All Memory
```http
GET /api/memory/all
X-Container-Id: optional-container-name
```

#### Clear Memory
```http
DELETE /api/memory/clear
X-Container-Id: optional-container-name
```

#### Health Check
```http
GET /api/memory/health
```

## Container Isolation

Each service can use its own memory space by specifying a container ID:

- **Header**: `X-Container-Id: backstage-booker`
- **Query Parameter**: `?container_id=segment-engine`
- **Default**: `default` container if not specified

### Example Services:
- `backstage-booker` - WWE Universe booking system
- `segment-engine` - Match segment generator
- `canon-manager` - Wrestling canon database
- `diagnostics` - System monitoring

## Database Setup

### Railway PostgreSQL Plugin
1. Add Railway Postgres plugin to your service
2. Set the `DATABASE_URL` environment variable
3. The schema will be automatically created on first startup

### Environment Variables
```bash
# Required for full functionality
DATABASE_URL=postgresql://username:password@host:port/database

# Authentication token for protected endpoints
ARCANOS_API_TOKEN=my-secret-token

# Optional - container identification
CONTAINER_ID=my-service-name
```

### Manual Database Setup
If using external PostgreSQL, run the schema file:
```bash
psql $DATABASE_URL -f sql/memory_state.sql
```

## Usage Examples

### Node.js/JavaScript
```javascript
const axios = require('axios');

// Save wrestling match result
await axios.post('http://localhost:8080/api/memory/save', {
  memory_key: 'last_match_result',
  memory_value: {
    winner: 'Roman Reigns',
    loser: 'Seth Rollins',
    match_type: 'Singles',
    timestamp: new Date().toISOString()
  }
}, {
  headers: {
    'X-Container-Id': 'backstage-booker',
    'Authorization': `Bearer ${process.env.ARCANOS_API_TOKEN}`
  }
});

// Load match result
const response = await axios.get('http://localhost:8080/api/memory/load?key=last_match_result', {
  headers: {
    'X-Container-Id': 'backstage-booker',
    'Authorization': `Bearer ${process.env.ARCANOS_API_TOKEN}`
  }
});
console.log(response.data.memory_value);
```

### cURL Examples
```bash
# Save memory
curl -X POST http://localhost:8080/api/memory/save \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ARCANOS_API_TOKEN" \
  -H "X-Container-Id: backstage-booker" \
  -d '{"memory_key": "universe_state", "memory_value": {"current_champion": "Roman Reigns"}}'

# Load memory
curl "http://localhost:8080/api/memory/load?key=universe_state" \
  -H "Authorization: Bearer $ARCANOS_API_TOKEN" \
  -H "X-Container-Id: backstage-booker"

# Health check
curl http://localhost:8080/api/memory/health \
  -H "Authorization: Bearer $ARCANOS_API_TOKEN"
```

## Deployment

### Railway Configuration
The service is pre-configured for Railway deployment:

1. **Environment Variables**:
   ```bash
   DATABASE_URL=postgresql://...  # From Railway Postgres plugin
   NODE_ENV=production
   ```

2. **Health Checks**: Available at `/health` and `/api/memory/health`

3. **Memory Optimization**: Configured for 8GB Railway Hobby Plan

### Docker Deployment
```dockerfile
# Use existing Dockerfile - memory service is included
ENV DATABASE_URL=postgresql://username:password@host:port/database
EXPOSE 8080
```

## Error Handling

### Graceful Degradation
- ✅ Service starts without database connection
- ✅ Returns meaningful error messages
- ✅ Health checks indicate degraded mode
- ✅ No crashes on database failures

### Error Responses
```json
{
  "error": "Database not configured",
  "details": "Memory service running in degraded mode"
}
```

## Monitoring

### Health Check Response
```json
{
  "service": "arcanos-memory",
  "status": "healthy|degraded|unhealthy",
  "database": true|false,
  "timestamp": "2025-07-21T05:47:48.378Z"
}
```

### Status Meanings
- **healthy**: Database connected and operational
- **degraded**: No database, basic functionality only
- **unhealthy**: Database connection failed

## Schema Details

### Memory State Table
```sql
CREATE TABLE memory_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_key TEXT NOT NULL,
    memory_value JSONB,
    container_id TEXT DEFAULT 'default',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(memory_key, container_id)
);
```

### Key Features
- UUID primary keys for global uniqueness
- JSONB for flexible value storage
- Automatic timestamps with triggers
- Container isolation via unique constraints
- Optimized indexes for performance

## Testing

Run the included test suite:
```bash
node test-memory-endpoints.js
```

This tests all endpoints and verifies container isolation works correctly.
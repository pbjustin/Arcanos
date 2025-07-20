# Route Trigger Logger

A utility for logging API endpoint usage across the Arcanos backend.

## Features

- **Safe to drop in any API endpoint** - Just add one line of code
- Logs timestamp, endpoint name, source IP, and user agent
- TypeScript support with proper typing
- Zero dependencies beyond Express.js

## Usage

```typescript
import { logEndpointCall } from '../services/endpoint-logger';

// Example usage in any route handler
app.get('/api/canon/files', (req, res) => {
  logEndpointCall('/api/canon/files', req);
  // ...your existing logic
});
```

## Log Format

The logger outputs structured console logs in this format:

```
[2025-07-20T21:15:34.213Z] 📡 /api/canon/files hit from ::1 (curl/8.5.0)
```

- **Timestamp**: ISO 8601 format 
- **Emoji**: 📡 (satellite/antenna) for easy visual identification
- **Endpoint**: The endpoint name you specify
- **Source IP**: Extracted from `req.ip` or `req.connection.remoteAddress`
- **User Agent**: From request headers, defaults to 'unknown' if missing

## Implementation

The logger is implemented in `/src/services/endpoint-logger.ts` and currently used in:

- `/api/canon/files` (GET) - Lists canon files
- `/api/canon/files/:filename` (GET) - Reads specific canon file  
- `/api/canon/files/:filename` (POST) - Writes canon file

## Testing

You can test the logger by running requests against the implemented endpoints:

```bash
# Start the development server
npm run dev

# Test the endpoints
curl http://localhost:8080/api/canon/files
curl http://localhost:8080/api/canon/files/test.json
curl -X POST -H "Content-Type: application/json" -d '{"content":"test"}' http://localhost:8080/api/canon/files/example.json
```

Check the server console output to see the logging in action.
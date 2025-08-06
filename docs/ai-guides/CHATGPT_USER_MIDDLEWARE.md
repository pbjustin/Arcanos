# ChatGPT-User Middleware Documentation

## Overview

The ChatGPT-User middleware provides secure handling of incoming requests from the ChatGPT-User agent, with IP whitelisting, request logging, and policy enforcement.

## Features

- ✅ **Exact User-Agent Detection**: Detects the specific ChatGPT-User agent string
- ✅ **IP Whitelisting**: Fetches and caches OpenAI's IP prefixes with hourly refresh
- ✅ **Request Logging**: Logs all ChatGPT-User requests with verification status
- ✅ **Policy Enforcement**: Allows GET requests, denies POST/PUT by default
- ✅ **Environment Toggle**: Can be enabled/disabled via `ENABLE_GPT_USER_HANDLER`
- ✅ **Diagnostic Endpoint**: Provides real-time status and configuration
- ✅ **Modular Design**: Can be used globally or per-route

## Configuration

Add to your `.env` file:
```
ENABLE_GPT_USER_HANDLER=true
```

## Usage

### Global Middleware (Already Configured)

The middleware is already configured globally in `src/index.ts`:

```typescript
app.use(chatGPTUserMiddleware({
  allowPostMethods: false, // Deny POST/PUT by default
  rateLimit: true,
  logToFile: false
}));
```

### Per-Route Usage

You can also apply the middleware to specific routes:

```typescript
import { chatGPTUserMiddleware } from './middleware/chatgpt-user';

// Apply to specific route
app.get('/api/chatgpt-endpoint', 
  chatGPTUserMiddleware({ allowPostMethods: true }), 
  (req, res) => {
    // Your route handler
  }
);

// Apply to route group
const chatgptRouter = express.Router();
chatgptRouter.use(chatGPTUserMiddleware({ allowPostMethods: true }));
app.use('/api/chatgpt', chatgptRouter);
```

## Options

```typescript
interface ChatGPTUserOptions {
  allowPostMethods?: boolean;  // Allow POST/PUT requests (default: false)
  rateLimit?: boolean;         // Enable rate limiting (default: true)
  logToFile?: boolean;         // Log to file (default: false)
  diagnosticsQueue?: any;      // Custom diagnostics queue
}
```

## Endpoints

### Status Endpoint
```
GET /chatgpt-user-status
```

Returns:
```json
{
  "enabled": true,
  "whitelist": {
    "lastFetch": 1753398791708,
    "isStale": false,
    "prefixCount": 103
  },
  "rateLimit": {
    "activeIPs": 0,
    "windowMs": 60000,
    "maxRequests": 10
  },
  "targetUserAgent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  "timestamp": "2025-07-24T23:15:51.236Z"
}
```

## Request Behavior

### ChatGPT-User Agent Detected:
- **GET Requests**: ✅ Always allowed
- **POST/PUT Requests**: ❌ Denied with 405 status (unless `allowPostMethods: true`)
- **Unverified IPs**: Tagged with `[UNVERIFIED GPT REQUEST]` in logs
- **Verified IPs**: Tagged with `[CHATGPT-USER ACCESS]` in logs

### Normal User Agents:
- **All Requests**: ✅ Pass through normally (no interference)

## Logging

The middleware logs all ChatGPT-User requests:

```
2025-07-24T23:13:32.808Z [UNVERIFIED GPT REQUEST] GET /health IP: ::1
2025-07-24T23:13:32.817Z [UNVERIFIED GPT REQUEST] POST / IP: ::1
[CHATGPT-USER] Denied POST request from ::1
```

## Rate Limiting

- **Window**: 60 seconds
- **Max Requests**: 10 per window per IP
- **Applied To**: Unverified IPs making POST/PUT requests
- **Response**: 429 status with retry-after header

## Testing

Run the comprehensive test suite:

```bash
# Start server with middleware enabled
ENABLE_GPT_USER_HANDLER=true npm start

# Run tests in another terminal
node test-chatgpt-user-comprehensive.js
```

## Security Features

1. **IP Validation**: Verifies requests against OpenAI's official IP prefixes
2. **Method Restriction**: Blocks non-GET methods by default
3. **Rate Limiting**: Prevents abuse from unverified IPs
4. **Fail-Safe**: Uses cached whitelist if fetch fails
5. **Logging**: Full audit trail of all ChatGPT-User activity

## Implementation Details

- **IP Cache**: Refreshed hourly from `https://openai.com/chatgpt-user.json`
- **Fallback**: Uses previous cache if fetch fails
- **Memory**: In-memory rate limiting with automatic cleanup
- **Thread-Safe**: Handles concurrent requests safely
- **Performance**: Minimal overhead for non-ChatGPT requests
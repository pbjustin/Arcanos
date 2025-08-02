# Memory Safe AI Module

The `memorySafeAI.js` module provides a memory-safe wrapper for OpenAI API calls with automatic memory monitoring and garbage collection.

## Features

- **Memory Monitoring**: Continuously monitors heap memory usage 
- **Automatic Garbage Collection**: Triggers GC every 30 seconds when `--expose-gc` flag is enabled
- **Memory Throttling**: Prevents OpenAI API calls when memory usage exceeds 80% of 512MB limit (409.6MB threshold)
- **Performance Logging**: Tracks API response times and memory metrics
- **Error Handling**: Graceful error handling for API failures and memory pressure

## Usage

```javascript
import { safeChat } from './memorySafeAI.js';

// Make a memory-safe OpenAI API call
const response = await safeChat('Hello, how are you?');

if (response.error) {
  console.error('Error:', response.error);
} else {
  console.log('AI Response:', response);
}
```

## Configuration

Set the following environment variable:
```bash
OPENAI_API_KEY=your-openai-api-key-here
```

## Memory Limits

- **Heap Limit**: 512MB
- **Throttling Threshold**: 80% of heap limit (409.6MB)
- **GC Schedule**: Every 30 seconds
- **Memory Logging**: Shows heap usage and RSS every 30 seconds

## Starting the Application

To enable garbage collection monitoring, start Node.js with the `--expose-gc` flag:

```bash
node --expose-gc your-app.js
```

## Memory Throttling Behavior

When memory usage exceeds the threshold:
- OpenAI API calls are blocked
- Returns error: `"Memory limit exceeded, try again later."`
- `isThrottled` flag is set to true
- GC continues to run automatically to free memory

## Error Responses

The module returns error objects in the following format:
```javascript
{
  error: "Error message here"
}
```

Common error scenarios:
- Memory limit exceeded
- OpenAI API key not configured  
- OpenAI API errors (rate limits, authentication, etc.)

## Performance Metrics

The module logs:
- `[GC] Manual GC triggered.` - When garbage collection runs
- `[MEM] HeapUsed: X MB | RSS: Y MB` - Memory usage statistics
- `[OPENAI] Completed in Xms` - API response times
- `[THROTTLE] Memory high — skipping OpenAI call.` - When throttling occurs

## Integration with Arcanos

This module follows the Arcanos project patterns for:
- Memory management and monitoring
- OpenAI API integration  
- Error handling and logging
- Performance optimization

## Testing

Run the included tests:
```bash
# Basic functionality test
node --expose-gc test-memorySafeAI.js

# Memory throttling test
node --expose-gc test-memory-throttling.js
```
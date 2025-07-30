# Web Fallback Service for ARCANOS

## Overview

The Web Fallback Service enables ARCANOS to fetch external web content when internal data is insufficient. It extracts, summarizes, and processes web content using GPT-4 for tactical analysis.

## Features

- **External Content Fetching**: Retrieve web content with proper User-Agent headers
- **HTML Content Extraction**: Clean and convert HTML to plain text 
- **GPT-4 Summarization**: Generate tactical summaries using OpenAI GPT-4
- **Batch Processing**: Handle multiple URLs simultaneously
- **URL Validation**: Pre-validate URLs before processing
- **Error Handling**: Robust error management with fallback responses

## Core Function (Problem Statement Implementation)

```typescript
import { webFallbackToGPT } from './src/services/web-fallback';

// Basic usage as specified in problem statement
const summary = await webFallbackToGPT({
  url: 'https://example.com/article',
  topic: 'AI development trends'
});

console.log(summary); // GPT-4 tactical summary of the web content
```

## API Endpoints

### POST /api/web-fallback/summarize

Main endpoint implementing the problem statement functionality.

**Request:**
```json
{
  "url": "https://example.com/article",
  "topic": "AI development trends"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Web content summarized successfully",
  "data": {
    "url": "https://example.com/article",
    "topic": "AI development trends",
    "summary": "Based on the web content, here is a tactical summary...",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

### POST /api/web-fallback/enhanced

Enhanced endpoint with additional configuration options.

**Request:**
```json
{
  "url": "https://example.com/article",
  "topic": "AI development trends",
  "timeout": 30000,
  "maxContentLength": 1000000
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Enhanced web fallback completed",
  "data": {
    "content": "Tactical summary of the content...",
    "metadata": {
      "url": "https://example.com/article",
      "contentLength": 15420,
      "processedAt": "2024-01-15T10:30:00.000Z",
      "tokensUsed": 1250
    }
  }
}
```

### POST /api/web-fallback/batch

Process multiple URLs in a single request.

**Request:**
```json
{
  "requests": [
    { "url": "https://example.com/article1", "topic": "AI trends" },
    { "url": "https://example.com/article2", "topic": "Web development" }
  ]
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Batch web fallback completed",
  "data": {
    "results": [
      {
        "success": true,
        "content": "Summary of article 1...",
        "metadata": { "url": "https://example.com/article1", ... }
      },
      {
        "success": true,
        "content": "Summary of article 2...",
        "metadata": { "url": "https://example.com/article2", ... }
      }
    ],
    "summary": {
      "total": 2,
      "successful": 2,
      "failed": 0
    },
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

### POST /api/web-fallback/validate

Validate URL accessibility before processing.

**Request:**
```json
{
  "url": "https://example.com/article"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "URL validation completed",
  "data": {
    "url": "https://example.com/article",
    "valid": true,
    "error": null,
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

### GET /api/web-fallback/status

Check service status and available endpoints.

**Response:**
```json
{
  "status": "success",
  "message": "Web fallback service is operational",
  "data": {
    "service": "Web Fallback Service",
    "version": "1.0.0",
    "features": [...],
    "endpoints": [...],
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

## Service Class Usage

```typescript
import { getWebFallbackService } from './src/services/web-fallback';

const service = getWebFallbackService();

// Enhanced processing with options
const result = await service.fetchAndSummarize({
  url: 'https://example.com/article',
  topic: 'AI development',
  timeout: 20000,
  maxContentLength: 500000
});

// URL validation
const validation = await service.validateUrl('https://example.com');

// Batch processing
const batchResults = await service.processBatch([
  { url: 'https://example.com/article1', topic: 'AI' },
  { url: 'https://example.com/article2', topic: 'Web Dev' }
]);
```

## Error Handling

The service includes comprehensive error handling:

- **Network Errors**: Connection timeouts, DNS failures, etc.
- **HTTP Errors**: 404, 500, rate limiting, etc.
- **Content Errors**: Invalid HTML, empty content, etc.
- **OpenAI Errors**: API failures, token limits, etc.

All errors return the fallback message: "⚠️ Could not retrieve or summarize external content."

## Configuration

The service uses these default settings:

- **Timeout**: 30 seconds for HTTP requests
- **Max Content Length**: 1MB per request
- **User-Agent**: "ARCANOS/1.0 (Web Intelligence Agent)"
- **GPT Model**: "gpt-4"
- **Temperature**: 0.3 (focused, deterministic responses)
- **Max Tokens**: 1500 for summaries

## Security & Rate Limiting

- All API endpoints require valid API tokens
- Batch processing limited to 10 URLs per request
- Content size limits prevent memory issues
- Proper User-Agent headers for ethical web scraping
- Error responses don't expose internal system details

## Dependencies

- **axios**: HTTP client for web requests
- **openai**: OpenAI SDK v5+ for GPT-4 integration
- **Unified OpenAI Service**: ARCANOS internal OpenAI abstraction

## Examples

See `/examples/web-fallback-demo.ts` for comprehensive usage examples and `/tests/test-web-fallback.ts` for test cases.

## Integration with ARCANOS

The web fallback service integrates seamlessly with existing ARCANOS services:

1. **Memory System**: Store summarized content for future reference
2. **AI Dispatcher**: Route external content requests automatically
3. **Game Guides**: Enhance guides with external content summaries
4. **Intent Analyzer**: Detect when external content is needed

This implementation fulfills the problem statement requirements while providing a robust, production-ready service for ARCANOS external content needs.
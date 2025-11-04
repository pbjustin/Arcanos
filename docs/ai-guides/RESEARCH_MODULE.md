# Research Module Documentation

## Overview

The Research Module provides deep multi-source research capabilities by fetching content from multiple URLs, summarizing each source with the configured research model, and synthesizing an overall research insight. This module extends ARCANOS's AI capabilities to perform comprehensive research analysis.

## Features

- **Multi-Source Research**: Fetch and analyze content from multiple URLs
- **AI-Powered Summarization**: Uses the configured research model (fine-tuned by default) to summarize each source
- **Intelligent Synthesis**: Combines all sources into a cohesive research brief
- **Memory Storage**: Stores research data in structured memory format
- **REST API**: Accessible via HTTP endpoint
- **Error Handling**: Graceful handling of failed URLs and network issues

## API Usage

### Endpoint: `POST /commands/research`

**Request:**
```json
{
  "topic": "machine learning fundamentals",
  "urls": [
    "https://en.wikipedia.org/wiki/Machine_learning",
    "https://www.ibm.com/topics/machine-learning",
    "https://www.coursera.org/learn/machine-learning"
  ]
}
```

**Response:**
```json
{
  "success": true,
  "topic": "machine learning fundamentals",
  "insight": "Machine learning is a subset of artificial intelligence that enables systems to learn and improve from experience without being explicitly programmed...",
  "sourcesProcessed": 3
}
```

## Programming Interface

### Function: `researchTopic(topic, urls)`

```typescript
import { researchTopic } from './src/modules/research';

const insight = await researchTopic(
  'artificial intelligence ethics',
  [
    'https://www.nature.com/articles/ai-ethics',
    'https://www.brookings.edu/research/algorithmic-bias'
  ]
);
```

**Parameters:**
- `topic` (string): The research topic
- `urls` (string[]): Array of URLs to research

**Returns:** Promise<string> - The synthesized research insight

## Memory Structure

The module stores research data in a structured format:

```
memory/
├── research/
│   └── {topic}/
│       ├── summary              # Final synthesized insight
│       └── sources/
│           ├── 1                # First source summary
│           ├── 2                # Second source summary
│           └── ...              # Additional sources
```

### Memory Content Format

**Summary (`research/{topic}/summary`):**
```json
{
  "topic": "machine learning fundamentals",
  "insight": "Comprehensive research brief...",
  "sources": 3
}
```

**Source (`research/{topic}/sources/{index}`):**
```json
{
  "url": "https://example.com/article",
  "content": "Summary of the article content..."
}
```

## Error Handling

The module handles various error scenarios:

- **Invalid URLs**: Skips URLs that cannot be fetched
- **Network Failures**: Continues with available sources
- **Content Type Issues**: Only processes HTML content
- **Empty URL Arrays**: Provides synthesis based on topic alone
- **API Failures**: Graceful fallback in test environments

## Testing

Run the comprehensive test suite:

```bash
npx ts-node tests/test-research.ts
```

View usage examples:

```bash
npx ts-node examples/research-example.ts
```

## Configuration

The module requires:
- `OPENAI_API_KEY` environment variable
- `RESEARCH_MODEL_ID` (optional) to target a dedicated fine-tuned model; falls back to the global AI model when unset
- Access to the ARCANOS memory service
- Network connectivity for URL fetching

In test environments, set `OPENAI_API_KEY` to `test_key_for_mocking` to enable mock responses.

## Integration

The research module is integrated into the ARCANOS system as:

1. **Express Router**: Available at `/commands/research`
2. **Memory Service**: Uses existing memory infrastructure
3. **OpenAI Integration**: Leverages centralized OpenAI client
4. **Error Handling**: Follows ARCANOS error handling patterns

## Performance Considerations

- URLs are processed sequentially to avoid overwhelming target servers
- Content is limited to first 3000 characters to manage API costs
- Failed URL fetches are logged but don't stop the research process
- Memory storage is optimized for retrieval and analysis
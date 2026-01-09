# GPT-5.2 Orchestration Shell - API Documentation

This implementation provides a GPT-5.2 Orchestration Shell with purge and redeploy functionality, fully integrated with the ARCANOS backend infrastructure.

## Features

- **Purge + Redeploy**: Complete orchestration shell reset with memory clearing
- **ARCANOS Integration**: Full integration with existing audit-safe, memory-aware, and logging systems  
- **OpenAI SDK Compatibility**: Works with v6.x of the OpenAI Node.js SDK
- **Fallback Safeguards**: Automatic fallback when OpenAI API is not available
- **Rebirth-Osiris v1.04**: Applies the specified configuration during redeploy

## API Endpoints

### POST /orchestration/reset
Performs a complete orchestration shell purge and redeploy sequence.

**Request:**
```bash
curl -X POST http://localhost:8080/orchestration/reset
```

**Response:**
```json
{
  "result": "Orchestration shell reset completed successfully",
  "module": "OrchestrationShell",
  "meta": {
    "id": "orchestration_reset_...",
    "created": 1754881108
  },
  "activeModel": "gpt-5.2",
  "fallbackFlag": false,
  "gpt5Used": true,
  "routingStages": ["ORCHESTRATION_RESET", "ISOLATE_MODULE", "PURGE_MEMORY", "REDEPLOY_SAFEGUARDS", "VERIFY_DEPLOYMENT"],
  "auditSafe": {
    "mode": true,
    "overrideUsed": false,
    "auditFlags": ["ORCHESTRATION", "SYSTEM_RESET"],
    "processedSafely": true
  },
  "memoryContext": {
    "entriesAccessed": 0,
    "contextSummary": "Orchestration reset - memory context cleared",
    "memoryEnhanced": false
  },
  "taskLineage": {
    "requestId": "orchestration_reset_...",
    "logged": true
  },
  "orchestration": {
    "success": true,
    "message": "✅ GPT-5.2 orchestration shell has been purged and redeployed.",
    "meta": {
      "timestamp": "2025-08-11T02:58:28.299Z",
      "stages": ["ISOLATE_MODULE", "PURGE_MEMORY", "REDEPLOY_SAFEGUARDS", "VERIFY_DEPLOYMENT"],
      "gpt5Model": "gpt-5.2",
      "safeguardsApplied": true
    },
    "logs": [
      "🔄 Starting GPT-5.2 Orchestration Shell purge...",
      "📦 Isolating orchestration shell...",
      "🧹 Purging memory state...",
      "🚀 Redeploying with safeguards...",
      "✅ Verifying deployment and ARCANOS integration...",
      "✅ GPT-5.2 orchestration shell has been purged and redeployed with ARCANOS integration."
    ]
  }
}
```

### GET /orchestration/status
Retrieves the current status of the orchestration shell.

**Request:**
```bash
curl -X GET http://localhost:8080/orchestration/status
```

**Response:**
```json
{
  "result": "Orchestration shell is active",
  "module": "OrchestrationShell",
  "orchestration": {
    "success": true,
    "message": "Status retrieved successfully",
    "status": {
      "active": true,
      "model": "gpt-5.2",
      "memoryEntries": 0,
      "lastReset": "2025-08-11T02:58:28.299Z"
    }
  }
}
```

### POST /orchestration/purge
Legacy endpoint providing the exact functionality from the problem statement.

**Request:**
```bash
curl -X POST http://localhost:8080/orchestration/purge
```

**Response:** Same as `/reset` but with specific message format matching the original requirements.

## Orchestration Process

The orchestration shell reset follows this sequence:

1. **Module Isolation**: Isolates the orchestration shell to prevent interference
2. **Memory Purge**: Clears cached context, variables, and stored configurations
3. **Safeguard Redeploy**: Redeploys with fallback safeguards and rebirth-osiris v1.04
4. **Verification**: Verifies deployment and ARCANOS system integration

## Integration Features

- **Audit-Safe Mode**: All operations are logged and audit-compliant
- **Memory Awareness**: Integrates with ARCANOS memory management system
- **Task Lineage**: Complete operation tracking for debugging
- **GPT-5.2 Routing**: Automatic routing through GPT-5.2 reasoning stages
- **Fallback Handling**: Graceful degradation when OpenAI API unavailable

## Standalone Script

You can also run the orchestration shell as a standalone script:

```bash
# Show status
node orchestration-demo.js status

# Run integrated ARCANOS version
node orchestration-demo.js integrated

# Run standalone version (original problem statement)
node orchestration-demo.js standalone
```

## Testing

Run the test suite to validate functionality:

```bash
# Run orchestration-specific tests
node tests/test-orchestration-shell.js

# Run full ARCANOS test suite
npm test
```

## Environment Variables

- `OPENAI_API_KEY` or `API_KEY`: OpenAI API key for GPT-5.2 access
- `GPT51_MODEL` / `GPT5_MODEL`: GPT-5.2 reasoning model identifiers (defaults to `gpt-5.2`)
- `ORCHESTRATION_LAST_RESET`: Timestamp of last reset (automatically set)

## Error Handling

The system gracefully handles:
- Missing OpenAI API keys (returns mock responses)
- Network connectivity issues
- Invalid GPT-5.2 model configurations
- Memory system failures

All errors are logged through the ARCANOS audit system with appropriate error codes and recovery suggestions.

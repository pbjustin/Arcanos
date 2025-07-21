# Copilot Router Implementation

This implementation adds copilot router functionality to the ARCANOS backend, enabling intelligent query routing based on fallback detection.

## Features

### Endpoint
- **POST** `/copilot/query` - Main copilot router endpoint

### Query Processing
- **Fallback Detection**: Automatically detects `--fallback` and `::default` markers in queries
- **Smart Routing**: Routes queries to appropriate services based on fallback detection
- **Query Cleaning**: Removes fallback markers from queries before processing

### Routing Logic
```typescript
// Normal queries go to finetune service
POST /copilot/query
{
  "query": "What is the meaning of life?",
  "mode": "logic"
}
// Routes to: sendToFinetune()

// Fallback queries go to core service  
POST /copilot/query
{
  "query": "What is the meaning of life? --fallback",
  "mode": "logic"
}
// Routes to: sendToCore()
// Cleaned query: "What is the meaning of life?"
```

### Services
- **Finetune Service** (`src/services/finetune.ts`): Handles normal queries
- **Core Service** (`src/services/finetune.ts`): Handles fallback queries
- **Core Ask Service** (`src/services/coreAsk.ts`): Alternative core service implementation

### Error Handling
- Missing query validation
- Service unavailability handling
- Comprehensive logging for debugging

### Logging
The implementation includes detailed logging to track:
- Query processing flow
- Fallback detection results
- Service routing decisions
- Request/response status
- Error conditions

## Implementation Files

```
src/
├── routes/
│   └── handleQuery.ts          # Main copilot router logic
├── services/
│   ├── finetune.ts            # Finetune and core services
│   └── coreAsk.ts             # Alternative core service
└── index.ts                   # Updated to include copilot endpoint
```

## Usage Examples

### Normal Query (Finetune Route)
```bash
curl -X POST http://localhost:3000/copilot/query \
  -H "Content-Type: application/json" \
  -d '{"query": "Explain quantum computing", "mode": "logic"}'
```

### Fallback Query (Core Route)  
```bash
curl -X POST http://localhost:3000/copilot/query \
  -H "Content-Type: application/json" \
  -d '{"query": "Explain quantum computing --fallback", "mode": "logic"}'
```

### Alternative Fallback Syntax
```bash
curl -X POST http://localhost:3000/copilot/query \
  -H "Content-Type: application/json" \
  -d '{"query": "Explain quantum computing ::default", "mode": "logic"}'
```

## Integration

The copilot router is fully integrated into the existing ARCANOS backend:
- Uses existing TypeScript infrastructure
- Leverages current Express.js setup
- Maintains compatibility with existing endpoints
- Follows established error handling patterns
- Includes comprehensive logging for monitoring

## Architecture

```
Client Request
     ↓
/copilot/query endpoint
     ↓
handleQuery.ts
     ↓
Fallback Detection
     ↓
   ┌────────────────┐
   │  isFallback?   │
   └────────┬───────┘
           │
     ┌─────▼─────┐         ┌─────▼─────┐
     │   FALSE   │         │    TRUE   │
     │ (normal)  │         │(fallback) │
     └─────┬─────┘         └─────┬─────┘
           │                     │
           ▼                     ▼
    sendToFinetune()      sendToCore()
           │                     │
           ▼                     ▼
    Finetune Service      Core Service
```
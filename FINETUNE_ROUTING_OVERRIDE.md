# 🔁 Fine-Tuned Model Routing Override (ARCANOS Shell)

This system allows you to redirect all prompt traffic through your fine-tuned OpenAI model for specialized output, bypassing the normal intent-based routing system.

## 🚀 Activate Fine-Tune Routing

To begin routing prompts through your fine-tuned model, issue any of the following commands in your ARCANOS shell or custom GPT:

### Primary Activation Commands
```plaintext
Force all prompts through my fine-tuned model until I say otherwise.
```

### Alternative Activation Commands
```plaintext
activate fine-tune routing
enable fine-tune override
use fine-tuned model for all prompts
route all prompts through fine-tuned model
```

## ⭕ Deactivate Fine-Tune Routing

To return to normal intent-based routing, use any of these commands:

### Primary Deactivation Commands
```plaintext
stop using fine-tuned model
```

### Alternative Deactivation Commands
```plaintext
disable fine-tune routing
deactivate fine-tune override
return to normal routing
end fine-tune override
```

## 📊 Check Routing Status

You can check the current routing status by calling the status endpoint:

```bash
GET /finetune-status
```

With optional headers to specify user/session:
```bash
X-User-ID: your-user-id
X-Session-ID: your-session-id
```

## 🔧 How It Works

### Normal Operation (Default)
```
User Message → Intent Analysis → ARCANOS:WRITE | ARCANOS:AUDIT | Fallback
```

### Override Mode (When Activated)
```
User Message → Fine-Tuned Model (Direct) → Response
```

### State Management
- **Per-User/Session**: Each user and session has independent routing state
- **Persistent**: Routing state survives server restarts
- **Memory Storage**: States are stored using the Universal Memory Archetype
- **Automatic Headers**: Uses `X-User-ID` and `X-Session-ID` headers (defaults to 'default' if not provided)

## 🧪 Testing

Run the comprehensive test suite:

```bash
node test-finetune-routing.js
```

This test validates:
- ✅ Initial state (inactive)
- ✅ Normal intent-based routing
- ✅ Activation command detection
- ✅ Status tracking and persistence
- ✅ Override routing behavior
- ✅ Deactivation command detection
- ✅ Return to normal routing

## 📝 API Examples

### Activate Override
```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "X-User-ID: user123" \
  -H "X-Session-ID: session456" \
  -d '{"message": "Force all prompts through my fine-tuned model until I say otherwise"}'
```

### Check Status
```bash
curl -X GET http://localhost:8080/finetune-status \
  -H "X-User-ID: user123" \
  -H "X-Session-ID: session456"
```

### Send Message (Will Use Override if Active)
```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "X-User-ID: user123" \
  -H "X-Session-ID: session456" \
  -d '{"message": "Tell me a story about robots"}'
```

### Deactivate Override
```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "X-User-ID: user123" \
  -H "X-Session-ID: session456" \
  -d '{"message": "stop using fine-tuned model"}'
```

## 🔍 Response Examples

### Status Response (Active)
```json
{
  "active": true,
  "message": "🎯 Fine-tuned model routing is ACTIVE (5 minutes). All prompts are being routed through your fine-tuned model. Say \"stop using fine-tuned model\" to deactivate.",
  "state": {
    "active": true,
    "activatedAt": "2025-07-22T00:52:17.944Z",
    "userId": "user123",
    "sessionId": "session456",
    "originalCommand": "Force all prompts through my fine-tuned model until I say otherwise"
  },
  "userId": "user123",
  "sessionId": "session456",
  "timestamp": "2025-07-22T00:57:17.947Z"
}
```

### Status Response (Inactive)
```json
{
  "active": false,
  "message": "⭕ Fine-tuned model routing is INACTIVE. Normal intent-based routing is active. Say \"Force all prompts through my fine-tuned model until I say otherwise\" to activate override.",
  "state": null,
  "userId": "user123",
  "sessionId": "session456",
  "timestamp": "2025-07-22T00:52:17.919Z"
}
```

## 🛠️ Implementation Details

### Files Created/Modified
- **New**: `/src/services/finetune-routing.ts` - Core routing override service
- **Modified**: `/src/index.ts` - Main endpoint with override logic integration
- **New**: `/test-finetune-routing.js` - Comprehensive test suite

### Dependencies
- Leverages existing `OpenAIService` for fine-tuned model calls
- Uses `MemoryStorage` for state persistence
- Integrates with existing intent-based `ArcanosRouter`
- Maintains compatibility with legacy `query-finetune:` prefix system

### Error Handling
- Graceful fallback when OpenAI API key is not configured
- Comprehensive error logging and user feedback
- Maintains service availability even when routing service fails

## 🔒 Security Notes

- User/session isolation prevents cross-contamination of routing states
- No sensitive data is stored in routing state
- Commands are case-insensitive and pattern-matched for reliability
- Memory storage follows existing Universal Memory Archetype security patterns

## 🚀 Production Deployment

The feature is production-ready and requires:
1. **Environment Variables**: Ensure `FINE_TUNED_MODEL` or `OPENAI_FINE_TUNED_MODEL` is set
2. **OpenAI API Key**: Configure `OPENAI_API_KEY` for model access
3. **Memory Storage**: Database connection for persistent state (optional, falls back to in-memory)

The system will work immediately upon deployment with no additional configuration needed.
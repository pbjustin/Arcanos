# Arcanos API Prompt Usage Guide

This comprehensive guide explains how to use prompts to interact with all available Arcanos API endpoints effectively.

## Table of Contents

1. [Quick Start](#quick-start)
2. [API Endpoints Overview](#api-endpoints-overview)
3. [Basic Prompting](#basic-prompting)
4. [Advanced Prompting Strategies](#advanced-prompting-strategies)
5. [Endpoint-Specific Guides](#endpoint-specific-guides)
6. [Configuration & Setup](#configuration--setup)
7. [Error Handling](#error-handling)
8. [Best Practices](#best-practices)
9. [Troubleshooting](#troubleshooting)

## Quick Start

### Prerequisites
1. Ensure your `.env` file is configured with:
   ```bash
   OPENAI_API_KEY=your-openai-api-key
   # Fine-tuned model (in order of precedence):
   AI_MODEL=your-fine-tuned-model-id
   FINE_TUNE_MODEL=your-alternative-model-id
   PORT=8080
   NODE_ENV=production
   RUN_WORKERS=false
   ```

2. Start the server:
   ```bash
   npm run build
   npm start
   ```

### Basic Test
```bash
curl -X POST http://localhost:8080/api/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello Arcanos!"}'
```

## API Endpoints Overview

| Endpoint | Purpose | Prompt Type | Fallback |
|----------|---------|-------------|----------|
| `/` | Main chat with intent routing | Natural language | Auto-routed |
| `/ask` | Simple query processing | Query/response | No |
| `/api/ask` | Fine-tuned model chat | Conversational | ❌ No fallback |
| `/api/ask-with-fallback` | AI chat with GPT-4 fallback | Conversational | ✅ GPT-4 fallback |
| `/api/ask-hrc` | Message validation using HRCCore overlay | Text validation | N/A |
| `/api/ask-v1-safe` | Safe interface with RAG/HRC | Structured queries | ❌ No fallback |
| `/api/arcanos` | Intent-based routing (WRITE/AUDIT) | Intent-driven | Depends on route |
| `/memory/save` | Store memories | Context storage | N/A |
| `/memory/load` | Retrieve memories | Context retrieval | N/A |
| `/api/diagnostics` | System diagnostics | Natural language commands | N/A |
| `/api/canon/files` | Canon file management | File operations | N/A |
| `/api/containers/status` | Container monitoring | Status queries | N/A |

## Basic Prompting

### Simple Conversational Prompts

For general AI interactions, use natural language:

```bash
curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Explain quantum computing in simple terms"
  }'
```

### Multi-turn Conversations

For continuing conversations, use the message array format:

```bash
curl -X POST http://localhost:8080/api/ask-with-fallback \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "What is machine learning?"},
      {"role": "assistant", "content": "Machine learning is a subset of AI..."},
      {"role": "user", "content": "Can you give me a practical example?"}
    ]
  }'
```

## Advanced Prompting Strategies

### 1. Domain-Specific Prompts

Use the `domain` parameter to optimize responses:

```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze this code for security vulnerabilities: function login(user, pass) { return user === admin && pass === 123; }",
    "domain": "security",
    "useRAG": true,
    "useHRC": true
  }'
```

### 2. Intent-Based Prompts

Structure prompts to trigger specific intents:

#### WRITE Intent (Content Creation)
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Write a function that calculates fibonacci numbers",
    "domain": "programming"
  }'
```

#### AUDIT Intent (Analysis/Review)
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Review this code for potential issues: const result = eval(userInput);",
    "domain": "security"
  }'
```

### 3. RAG-Enhanced Prompts

Leverage stored context for better responses:

```bash
# First, store some context
curl -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{
    "value": "The user prefers Python over JavaScript for backend development"
  }'

# Then ask a question that can benefit from this context
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What programming language should I use for my new API project?",
    "useRAG": true
  }'
```

## Endpoint-Specific Guides

### `/api/ask` - Primary AI Endpoint

**Purpose**: Direct interaction with your fine-tuned model only
**Fallback**: None (fails if fine-tuned model unavailable)

#### Basic Usage:
```bash
curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Your prompt here"
  }'
```

#### Effective Prompts:
- **Technical Questions**: "Explain the difference between REST and GraphQL APIs"
- **Code Generation**: "Create a Python function that validates email addresses"
- **Analysis**: "What are the pros and cons of microservices architecture?"

### `/api/ask-with-fallback` - Fallback-Enabled AI

**Purpose**: AI interaction with GPT-4 fallback if fine-tuned model fails
**Fallback**: GPT-4 Turbo

#### Single Message:
```bash
curl -X POST http://localhost:8080/api/ask-with-fallback \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Design a database schema for an e-commerce platform"
  }'
```

#### Conversation History:
```bash
curl -X POST http://localhost:8080/api/ask-with-fallback \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "I need help with my React app"},
      {"role": "assistant", "content": "I'd be happy to help! What specific issue are you facing?"},
      {"role": "user", "content": "State management is getting complex"}
    ]
  }'
```

### `/api/ask-hrc` - Message Validation

**Purpose**: Validate messages using HRCCore before processing

```bash
curl -X POST http://localhost:8080/api/ask-hrc \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Please review this sensitive data: API_KEY=abc123"
  }'
```

### `/api/ask-v1-safe` - Safe Interface

**Purpose**: Structured interface with RAG and HRC integration
**Features**: Domain specification, RAG toggle, HRC validation

```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Help me optimize this SQL query for better performance",
    "domain": "database",
    "useRAG": true,
    "useHRC": true
  }'
```

#### Domain-Specific Examples:

**Security Domain:**
```json
{
  "message": "Audit this authentication function for vulnerabilities",
  "domain": "security",
  "useRAG": true,
  "useHRC": true
}
```

**General Domain:**
```json
{
  "message": "Explain the benefits of cloud computing",
  "domain": "general",
  "useRAG": false,
  "useHRC": false
}
```

### `/api/arcanos` - Intent-Based Routing

**Purpose**: Automatically route to WRITE or AUDIT based on intent analysis

#### Content Creation (WRITE Intent):
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a REST API endpoint for user registration",
    "domain": "programming"
  }'
```

#### Analysis/Review (AUDIT Intent):
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze this code for potential security issues",
    "domain": "security"
  }'
```

#### Response Format:
```json
{
  "success": true,
  "response": "AI generated response...",
  "intent": "WRITE" | "AUDIT",
  "confidence": 0.95,
  "reasoning": "Intent classification explanation",
  "model": "model-used",
  "metadata": {}
}
```

### `/api/memory` - Context Storage

#### Store Memory:
```bash
curl -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{
    "value": "User prefers TypeScript for new projects"
  }'
```

#### Retrieve Memories:
```bash
curl -X GET http://localhost:8080/api/memory
```

### `/api/openai/prompt` - Direct Model Access

**Purpose**: Send a prompt directly to a specific model.
**Parameters**:
- `prompt` (string) - required user prompt
- `model` (string, optional) - fine-tuned model ID. Defaults to `AI_MODEL` when omitted

```bash
curl -X POST http://localhost:8080/api/openai/prompt \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Hello there",
    "model": "ft:gpt-4.1-my-custom-model"
  }'
```

If `model` is not provided, the server uses the `AI_MODEL` environment variable.

## Configuration & Setup

### Environment Variables

```bash
# Required
OPENAI_API_KEY=sk-proj-your-api-key-here
FINE_TUNED_MODEL=ft:gpt-3.5-turbo:your-org:model-name:id

# Optional
PORT=8080
NODE_ENV=production
RUN_WORKERS=true
```

### Model Configuration

1. **Fine-tuned Model**: Set `FINE_TUNED_MODEL` for primary model
2. **Fallback Model**: GPT-4 Turbo used automatically when fallback enabled
3. **Model Status Check**:
   ```bash
   curl http://localhost:8080/api/model-status
   ```

## Error Handling

### Common Error Responses

#### Missing Fine-tuned Model:
```json
{
  "error": "Fine-tuned model is missing. Fallback not allowed without user permission."
}
```

#### Model Invocation Failed:
```json
{
  "error": "Model invocation failed. Fine-tuned model may be unavailable.",
  "model": "ft:gpt-3.5-turbo:your-org:model-name:id"
}
```

#### Invalid Request:
```json
{
  "error": "Either \"message\" (string) or \"messages\" (array) is required"
}
```

### Handling Errors in Your Application

```javascript
async function callArcanosAPI(message) {
  try {
    const response = await fetch('http://localhost:8080/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      if (data.error?.includes('Fine-tuned model is missing')) {
        // Try fallback endpoint
        return await callWithFallback(message);
      }
      throw new Error(data.error);
    }
    
    return data.response;
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}
```

## Best Practices

### 1. Prompt Engineering

#### Be Specific and Clear:
✅ **Good**: "Create a Python function that validates email addresses using regex"
❌ **Poor**: "Make email thing"

#### Provide Context:
✅ **Good**: "As a senior developer, review this React component for performance issues"
❌ **Poor**: "Check this code"

#### Use Domain Specification:
```json
{
  "message": "Your prompt here",
  "domain": "security|programming|database|general",
  "useRAG": true
}
```

### 2. Endpoint Selection

- **`/api/ask`**: Use for reliable fine-tuned model responses
- **`/api/ask-with-fallback`**: Use when availability is more important than model consistency
- **`/api/ask-v1-safe`**: Use for structured requests with validation
- **`/api/arcanos`**: Use when you want automatic intent-based routing

### 3. Memory Management

Store relevant context for better responses:
```bash
# Store preferences
curl -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{"value": "User works primarily with Node.js and TypeScript"}'

# Store project context
curl -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{"value": "Current project: E-commerce API using Express and MongoDB"}'
```

### 4. Error Recovery

Implement graceful fallback in your applications:
```javascript
async function robustAPICall(message) {
  // Try primary endpoint first
  try {
    return await callAPI('/api/ask', { message });
  } catch (error) {
    console.log('Primary endpoint failed, trying fallback...');
    return await callAPI('/api/ask-with-fallback', { message });
  }
}
```

## Troubleshooting

### Issue: "Fine-tuned model is missing"

**Cause**: `FINE_TUNED_MODEL` not set or invalid
**Solution**: 
1. Check your `.env` file
2. Verify the model ID is correct
3. Use `/api/ask-with-fallback` for immediate access

### Issue: "OpenAI service not initialized"

**Cause**: Missing or invalid `OPENAI_API_KEY`
**Solution**:
1. Verify API key in `.env` file
2. Check API key permissions
3. Test with a simple curl command

### Issue: Empty or Error Responses

**Cause**: Various - check response for details
**Solution**:
1. Check model status: `GET /api/model-status`
2. Verify request format
3. Check server logs

### Issue: Intent Routing Not Working

**Cause**: Ambiguous prompts or intent analyzer issues
**Solution**:
1. Make prompts more explicit
2. Use specific action words (create, analyze, review, build)
3. Check the `intent` field in response

### Testing Your Setup

```bash
# Test health
curl http://localhost:8080/health

# Test model status
curl http://localhost:8080/api/model-status

# Test basic functionality
curl -X POST http://localhost:8080/api/echo \
  -H "Content-Type: application/json" \
  -d '{"test": "message"}'

# Test AI functionality
curl -X POST http://localhost:8080/api/ask-with-fallback \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, are you working?"}'
```

## Summary

This guide covers all available methods for using prompts with the Arcanos API. Choose the appropriate endpoint based on your needs:

- **Standard AI chat**: `/api/ask` or `/api/ask-with-fallback`
- **Structured queries**: `/api/ask-v1-safe`
- **Intent-based routing**: `/api/arcanos`
- **Validation**: `/api/ask-hrc`
- **Context management**: `/api/memory`

Always follow best practices for prompt engineering and implement proper error handling in your applications.
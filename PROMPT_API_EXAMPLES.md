# Arcanos API Practical Examples

This file contains ready-to-use examples for testing and implementing Arcanos API endpoints.

## Setup Test Environment

First, create your environment file:
```bash
cp .env.example .env
# Edit .env with your actual OpenAI credentials
```

## Basic Connectivity Tests

### 1. Health Check
```bash
curl http://localhost:8080/health
# Expected: ✅ OK
```

### 2. API Welcome
```bash
curl http://localhost:8080/api
# Expected: JSON with welcome message and model status
```

### 3. Echo Test
```bash
curl -X POST http://localhost:8080/api/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello Arcanos!", "test": true}'
# Expected: Echo of your input data
```

### 4. Model Status
```bash
curl http://localhost:8080/api/model-status
# Expected: Model configuration status
```

## AI Interaction Examples

### Basic AI Chat (No Fallback)
```bash
curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the difference between REST and GraphQL?"
  }'
```

### AI Chat with Fallback Support
```bash
curl -X POST http://localhost:8080/api/ask-with-fallback \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Explain microservices architecture and its benefits"
  }'
```

### Multi-turn Conversation
```bash
curl -X POST http://localhost:8080/api/ask-with-fallback \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "I need help with Python"},
      {"role": "assistant", "content": "I'd be happy to help with Python! What specific topic would you like assistance with?"},
      {"role": "user", "content": "How do I handle exceptions properly?"}
    ]
  }'
```

## Programming Examples

### Code Generation
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a Python function that validates email addresses using regex",
    "domain": "programming"
  }'
```

### Code Review/Audit
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Review this code for security issues: function login(user, pass) { return user === admin && pass === 123; }",
    "domain": "security"
  }'
```

### API Design
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Design a RESTful API for a blog platform with users, posts, and comments",
    "domain": "programming",
    "useRAG": true,
    "useHRC": false
  }'
```

### Database Design
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a database schema for an e-commerce platform with products, users, orders, and inventory",
    "domain": "database",
    "useRAG": true,
    "useHRC": true
  }'
```

## Security Analysis Examples

### Vulnerability Assessment
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze this SQL query for injection vulnerabilities: SELECT * FROM users WHERE id = " + userId,
    "domain": "security"
  }'
```

### Authentication Review
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Review this authentication implementation for security best practices: const auth = (req, res, next) => { if (req.headers.token === process.env.SECRET) next(); else res.status(401).send(); }",
    "domain": "security",
    "useRAG": true,
    "useHRC": true
  }'
```

## Memory and Context Examples

### Store Context
```bash
# Store user preferences
curl -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{
    "value": "User prefers TypeScript over JavaScript for new projects"
  }'

# Store project context
curl -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{
    "value": "Current project: Building a real-time chat application using Socket.io and Node.js"
  }'

# Store technical requirements
curl -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{
    "value": "System requirements: Must support 10k concurrent users, Redis for caching, PostgreSQL database"
  }'
```

### Retrieve Context
```bash
curl http://localhost:8080/api/memory
```

### Context-Aware Query
```bash
# After storing context, ask a related question
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What technology stack would you recommend for my new project?",
    "domain": "programming",
    "useRAG": true,
    "useHRC": false
  }'
```

## Validation Examples

### HRC Message Validation
```bash
curl -X POST http://localhost:8080/api/ask-hrc \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Please analyze this code: console.log(userPassword);"
  }'
```

### Safe Interface with All Features
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Help me optimize this database query for better performance: SELECT * FROM orders o JOIN users u ON o.user_id = u.id WHERE o.created_at > 2023-01-01",
    "domain": "database",
    "useRAG": true,
    "useHRC": true
  }'
```

## Intent-Based Routing Examples

### Content Creation (Should Route to WRITE)
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Write a React component for user login form",
    "domain": "programming"
  }'
```

### Analysis/Review (Should Route to AUDIT)
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Audit this Docker configuration for security best practices",
    "domain": "security"
  }'
```

### Documentation Creation
```bash
curl -X POST http://localhost:8080/api/arcanos \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Generate API documentation for a user management service",
    "domain": "general"
  }'
```

## Testing Different Domains

### General Domain
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Explain the benefits and drawbacks of cloud computing",
    "domain": "general",
    "useRAG": false,
    "useHRC": false
  }'
```

### Programming Domain
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What are the SOLID principles in software design?",
    "domain": "programming",
    "useRAG": true,
    "useHRC": false
  }'
```

### Security Domain
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Explain OWASP Top 10 security vulnerabilities",
    "domain": "security",
    "useRAG": true,
    "useHRC": true
  }'
```

### Database Domain
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Compare SQL vs NoSQL databases for a social media application",
    "domain": "database",
    "useRAG": true,
    "useHRC": false
  }'
```

## Error Handling Examples

### Missing Message
```bash
curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: Error about missing message
```

### Invalid Endpoint
```bash
curl -X POST http://localhost:8080/api/nonexistent \
  -H "Content-Type: application/json" \
  -d '{"message": "test"}'
# Expected: 404 error
```

### Test Without API Key
```bash
# With empty/invalid API key, you should see configuration errors
curl http://localhost:8080/api/model-status
```

## Batch Testing Script

Create a test script to validate all endpoints:

```bash
#!/bin/bash

echo "=== Testing Arcanos API ==="

echo "1. Health Check:"
curl -s http://localhost:8080/health
echo -e "\n"

echo "2. API Welcome:"
curl -s http://localhost:8080/api | jq .
echo -e "\n"

echo "3. Echo Test:"
curl -s -X POST http://localhost:8080/api/echo \
  -H "Content-Type: application/json" \
  -d '{"test": "hello"}' | jq .
echo -e "\n"

echo "4. Model Status:"
curl -s http://localhost:8080/api/model-status | jq .
echo -e "\n"

echo "5. Memory Test:"
curl -s -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{"value": "test memory"}' | jq .
echo -e "\n"

echo "6. HRC Validation:"
curl -s -X POST http://localhost:8080/api/ask-hrc \
  -H "Content-Type: application/json" \
  -d '{"message": "test validation"}' | jq .
echo -e "\n"

echo "=== Test Complete ==="
```

Save as `test-api.sh`, make executable with `chmod +x test-api.sh`, and run with `./test-api.sh`.

## JavaScript/Node.js Integration Examples

### Simple Client
```javascript
const axios = require('axios');

class ArcanosClient {
  constructor(baseURL = 'http://localhost:8080') {
    this.baseURL = baseURL;
  }

  async ask(message, options = {}) {
    try {
      const response = await axios.post(`${this.baseURL}/api/ask`, {
        message,
        ...options
      });
      return response.data;
    } catch (error) {
      if (error.response?.data?.error?.includes('Fine-tuned model')) {
        // Try fallback
        return await this.askWithFallback(message, options);
      }
      throw error;
    }
  }

  async askWithFallback(message, options = {}) {
    const response = await axios.post(`${this.baseURL}/api/ask-with-fallback`, {
      message,
      ...options
    });
    return response.data;
  }

  async askSafe(message, domain = 'general', useRAG = true, useHRC = true) {
    const response = await axios.post(`${this.baseURL}/api/ask-v1-safe`, {
      message,
      domain,
      useRAG,
      useHRC
    });
    return response.data;
  }

  async arcanos(message, domain = 'general') {
    const response = await axios.post(`${this.baseURL}/api/arcanos`, {
      message,
      domain
    });
    return response.data;
  }

  async storeMemory(value) {
    const response = await axios.post(`${this.baseURL}/api/memory`, { value });
    return response.data;
  }

  async getMemories() {
    const response = await axios.get(`${this.baseURL}/api/memory`);
    return response.data;
  }
}

// Usage example
async function example() {
  const client = new ArcanosClient();
  
  try {
    // Store some context
    await client.storeMemory('User is working on a Node.js project');
    
    // Ask a question with context
    const result = await client.askSafe(
      'What testing framework would you recommend?',
      'programming',
      true,
      false
    );
    
    console.log('Response:', result.response);
  } catch (error) {
    console.error('Error:', error.message);
  }
}
```

### Python Integration Example
```python
import requests
import json

class ArcanosClient:
    def __init__(self, base_url="http://localhost:8080"):
        self.base_url = base_url
    
    def ask(self, message, **options):
        try:
            response = requests.post(
                f"{self.base_url}/api/ask",
                json={"message": message, **options}
            )
            return response.json()
        except requests.exceptions.RequestException as e:
            # Try fallback
            return self.ask_with_fallback(message, **options)
    
    def ask_with_fallback(self, message, **options):
        response = requests.post(
            f"{self.base_url}/api/ask-with-fallback",
            json={"message": message, **options}
        )
        return response.json()
    
    def ask_safe(self, message, domain="general", use_rag=True, use_hrc=True):
        response = requests.post(
            f"{self.base_url}/api/ask-v1-safe",
            json={
                "message": message,
                "domain": domain,
                "useRAG": use_rag,
                "useHRC": use_hrc
            }
        )
        return response.json()
    
    def arcanos(self, message, domain="general"):
        response = requests.post(
            f"{self.base_url}/api/arcanos",
            json={"message": message, "domain": domain}
        )
        return response.json()

# Usage
client = ArcanosClient()
result = client.ask_safe("Explain Python decorators", "programming")
print(result["response"])
```

These examples provide a comprehensive set of ready-to-use implementations for testing and integrating with the Arcanos API.
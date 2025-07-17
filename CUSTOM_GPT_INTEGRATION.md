# Arcanos Custom GPT Integration Guide

This guide explains how to fully integrate your Arcanos AI operating system with Custom GPTs in ChatGPT and native applications.

## Table of Contents
- [Overview](#overview)
- [Custom GPT Setup](#custom-gpt-setup)
- [API Configuration](#api-configuration)
- [Actions Configuration](#actions-configuration)
- [Native App Integration](#native-app-integration)
- [Model Management](#model-management)
- [Troubleshooting](#troubleshooting)

## Overview

Arcanos provides a robust API that can be integrated with ChatGPT Custom GPTs, allowing you to leverage your fine-tuned models and AI capabilities directly within ChatGPT conversations.

### Key Features
- **Fine-tuned Model Support**: Uses your custom model `ft:gpt-3.5-turbo-0125:personal:arc_v1-1106:BpYtP0ox`
- **Smart Fallback**: Falls back to `gpt-4-turbo` with permission when fine-tune model is unavailable
- **Interactive Permission System**: Prompts for fallback approval
- **RAG Integration**: Enhanced responses with retrieval-augmented generation
- **Memory Persistence**: Maintains conversation context and memories

## Custom GPT Setup

### 1. Create a New Custom GPT

1. Go to ChatGPT and click "Create a GPT"
2. Set up your GPT with a name and description
3. Configure the instructions to work with Arcanos

### 2. GPT Instructions Template

```markdown
You are an AI assistant powered by the Arcanos AI operating system. You have access to advanced capabilities through the Arcanos API including:

- Fine-tuned model responses via your custom model
- RAG (Retrieval Augmented Generation) capabilities
- Persistent memory storage
- System configuration management

When users ask questions:
1. Use the Arcanos API to get enhanced responses
2. Store important information in Arcanos memory
3. Leverage the RAG system for context-aware answers
4. Monitor system status and configuration as needed

Always provide helpful, accurate responses while leveraging the advanced capabilities of the Arcanos system.
```

## API Configuration

### Base Configuration
- **Server URL**: `https://your-arcanos-deployment.com` (replace with your actual deployment URL)
- **Authentication**: No authentication required (single-user system)
- **Content Type**: `application/json`

### Project Structure
The new Arcanos backend uses a clean TypeScript + Express structure:

```
/src/
  index.ts         # Main Express server
  routes/
    index.ts       # API routes
package.json       # Dependencies and scripts
tsconfig.json      # TypeScript configuration
.env.example       # Environment template
dist/              # Compiled JavaScript (generated)
```

### Environment Variables
Create a `.env` file in the project root with the following variables:

```bash
# OpenAI Configuration
OPENAI_API_KEY=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
FINE_TUNED_MODEL=ft:gpt-3.5-turbo-0125:personal:arc_v1-1106:BpYtP0ox

# Server Configuration
PORT=3000
NODE_ENV=production
```

### Development Setup
```bash
# Install dependencies
npm install

# Development mode (with hot reloading)
npm run dev

# Production build
npm run build
npm start

# Health check
curl http://localhost:3000/health
```

## Actions Configuration

Add these actions to your Custom GPT to enable full Arcanos integration:

### Current Available Endpoints

The new backend structure provides these base endpoints:

```yaml
openapi: 3.0.0
info:
  title: Arcanos AI API
  version: 1.0.0
servers:
  - url: https://your-arcanos-deployment.com
paths:
  /health:
    get:
      operationId: getHealth
      summary: Health check endpoint
      responses:
        '200':
          description: System health status
          content:
            application/json:
              schema:
                type: object
                properties:
                  status:
                    type: string
                  timestamp:
                    type: string
                  uptime:
                    type: number
  /api:
    get:
      operationId: getWelcome
      summary: API welcome message
      responses:
        '200':
          description: Welcome response
          content:
            application/json:
              schema:
                type: object
                properties:
                  message:
                    type: string
                  timestamp:
                    type: string
                  version:
                    type: string
  /api/echo:
    post:
      operationId: echoTest
      summary: Echo test endpoint
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
      responses:
        '200':
          description: Echo response
          content:
            application/json:
              schema:
                type: object
                properties:
                  message:
                    type: string
                  data:
                    type: object
                  timestamp:
                    type: string
```

### Future Endpoints (To Be Implemented)

These are the endpoints you'll want to implement for full Arcanos functionality:

```yaml
  /api/ask:
    post:
      operationId: askArcanos
      summary: Send a query to the Arcanos AI system
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                query:
                  type: string
                  description: The user's question or request
                options:
                  type: object
                  properties:
                    useRAG:
                      type: boolean
                      description: Whether to use RAG capabilities
                      default: true
              required:
                - query
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                type: object
                properties:
                  success:
                    type: boolean
                  response:
                    type: string
                  metadata:
                    type: object

  /api/memory:
    get:
      operationId: getMemories
      summary: Retrieve stored memories
      responses:
        '200':
          description: List of memories
    post:
      operationId: storeMemory
      summary: Store a new memory
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                content:
                  type: string
                tags:
                  type: array
                  items:
                    type: string
                priority:
                  type: string
                  enum: [low, medium, high]
              required:
                - content

  /api/status:
    get:
      operationId: getSystemStatus
      summary: Get Arcanos system status
      responses:
        '200':
          description: System status information
  
  /api/config:
    get:
      operationId: getConfiguration
      summary: Get system configuration
      responses:
        '200':
          description: Current configuration
```

## Native App Integration

### Frontend Integration

For native app integration, you can create a simple frontend that communicates with your Arcanos backend:

#### HTML Interface Example

```html
<!DOCTYPE html>
<html>
<head>
    <title>Arcanos Chat Interface</title>
    <style>
        .chat-container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .message { margin: 10px 0; padding: 10px; border-radius: 5px; }
        .user { background: #e3f2fd; text-align: right; }
        .assistant { background: #f5f5f5; }
        .input-area { margin-top: 20px; }
        input { width: 70%; padding: 10px; }
        button { padding: 10px 20px; background: #2196f3; color: white; border: none; border-radius: 5px; }
    </style>
</head>
<body>
    <div class="chat-container">
        <h1>Arcanos AI Chat</h1>
        <div id="chat-messages"></div>
        <div class="input-area">
            <input type="text" id="user-input" placeholder="Ask Arcanos anything...">
            <button onclick="sendMessage()">Send</button>
        </div>
    </div>

    <script>
        const API_BASE = 'https://your-arcanos-deployment.com';
        
        async function sendMessage() {
            const input = document.getElementById('user-input');
            const message = input.value.trim();
            if (!message) return;
            
            addMessage(message, 'user');
            input.value = '';
            
            try {
                // For now, use the echo endpoint since /api/ask isn't implemented yet
                const response = await fetch(`${API_BASE}/api/echo`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: message, message: message })
                });
                
                const data = await response.json();
                addMessage(data.message || 'Echo: ' + message, 'assistant');
                
                // TODO: Implement /api/ask endpoint and update to:
                /*
                const response = await fetch(`${API_BASE}/api/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: message, options: { useRAG: true } })
                });
                
                const data = await response.json();
                addMessage(data.response, 'assistant');
                
                // Store important conversations in memory
                if (data.success && message.length > 50) {
                    await fetch(`${API_BASE}/api/memory`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            content: `Q: ${message}\nA: ${data.response}`,
                            tags: ['conversation'],
                            priority: 'medium'
                        })
                    });
                }
                */
            } catch (error) {
                addMessage('Error: Could not connect to Arcanos', 'assistant');
            }
        }
        
        function addMessage(text, sender) {
            const messagesDiv = document.getElementById('chat-messages');
            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${sender}`;
            messageDiv.textContent = text;
            messagesDiv.appendChild(messageDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        
        document.getElementById('user-input').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') sendMessage();
        });
    </script>
</body>
</html>
```

#### React Component Example

```jsx
import React, { useState, useEffect } from 'react';

const ArcanosChat = () => {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    
    const API_BASE = 'https://your-arcanos-deployment.com';
    
    const sendMessage = async () => {
        if (!input.trim()) return;
        
        const userMessage = { text: input, sender: 'user' };
        setMessages(prev => [...prev, userMessage]);
        setLoading(true);
        
        try {
            // For now, use the echo endpoint since /api/ask isn't implemented yet
            const response = await fetch(`${API_BASE}/api/echo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    query: input, 
                    message: input 
                })
            });
            
            const data = await response.json();
            const assistantMessage = { 
                text: data.message || `Echo: ${input}`, 
                sender: 'assistant',
                metadata: data.metadata || {} 
            };
            
            setMessages(prev => [...prev, assistantMessage]);
            
            // TODO: Implement /api/ask endpoint and update to:
            /*
            const response = await fetch(`${API_BASE}/api/ask`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    query: input, 
                    options: { useRAG: true } 
                })
            });
            
            const data = await response.json();
            const assistantMessage = { 
                text: data.response, 
                sender: 'assistant',
                metadata: data.metadata 
            };
            
            setMessages(prev => [...prev, assistantMessage]);
            */
        } catch (error) {
            setMessages(prev => [...prev, { 
                text: 'Error connecting to Arcanos', 
                sender: 'assistant' 
            }]);
        }
        
        setInput('');
        setLoading(false);
    };
    
    return (
        <div className="arcanos-chat">
            <div className="messages">
                {messages.map((msg, idx) => (
                    <div key={idx} className={`message ${msg.sender}`}>
                        {msg.text}
                        {msg.metadata && (
                            <div className="metadata">
                                Timestamp: {msg.metadata.timestamp}
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <div className="input-area">
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                    placeholder="Ask Arcanos..."
                    disabled={loading}
                />
                <button onClick={sendMessage} disabled={loading}>
                    {loading ? 'Thinking...' : 'Send'}
                </button>
            </div>
        </div>
    );
};

export default ArcanosChat;
```

## Model Management

### Fine-Tuned Model Configuration

Your Arcanos system is configured to use your fine-tuned model:
- **Model ID**: `ft:gpt-3.5-turbo-0125:personal:arc_v1-1106:BpYtP0ox`
- **Fallback Model**: `gpt-4-turbo` (ChatGPT Plus)

### Interactive Permission System

When your fine-tuned model is unavailable, Arcanos will prompt:

```
🚨 ARCANOS PERMISSION REQUEST 🚨
Issue: Fine-tune model failed: [error details]
I cannot access your fine-tune model.
Would you like me to fall back to the default model (gpt-4-turbo)?
Allow fallback to default model? (yes/no):
```

### Programmatic Permission Management

You can also manage permissions via API:

```javascript
// Check permission status
const permissionStatus = await fetch('/api/permission/status');

// Grant permission programmatically
await fetch('/api/permission/grant', { method: 'POST' });

// Revoke permission
await fetch('/api/permission/revoke', { method: 'POST' });
```

## Troubleshooting

### Common Issues

1. **Fine-tune model not accessible**
   - Check your OpenAI API key permissions
   - Verify the fine-tune model ID is correct
   - Grant fallback permission when prompted

2. **API connection errors**
   - Ensure your Arcanos server is running
   - Check the server URL in your Custom GPT configuration
   - Verify CORS settings allow ChatGPT domains

3. **Memory not persisting**
   - Check server storage permissions
   - Verify memory API endpoints are working
   - Review server logs for storage errors

### Debug Endpoints

Use these endpoints to debug your integration:

```bash
# Check system health (available now)
GET /health

# Test API connection (available now)
GET /api

# Test echo functionality (available now)
POST /api/echo

# Future endpoints (to be implemented):
# Get detailed system status
GET /api/status

# View current configuration
GET /api/config
```

### Logs and Monitoring

Monitor your Arcanos deployment logs to track:
- Model usage (fine-tune vs fallback)
- API call success rates
- Permission requests and grants
- Memory storage operations

## Support

For additional support or questions about Custom GPT integration:
1. Check the server logs for detailed error messages
2. Test individual API endpoints using tools like Postman
3. Verify your environment variables are correctly set
4. Contact @pbjustin for repository-specific issues

---

**Note**: Replace `https://your-arcanos-deployment.com` with your actual Arcanos server URL throughout this documentation.
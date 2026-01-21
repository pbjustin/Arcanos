# ARCANOS GitHub Integration Guide

This guide explains how to set up and use ARCANOS as a full backend controller with GitHub integration, as specified in the requirements.

## 🚀 Overview

ARCANOS now operates in **agent-control** mode with the following capabilities:

- ✅ **Backend Logic Read/Write**: Full CRUD operations on backend systems
- ✅ **GitHub Actions Triggering**: Automatic workflow execution based on repository events
- ✅ **OpenAI SDK Integration**: Modular, secured, and token-efficient AI operations
- ✅ **Webhook Handlers**: Support for onPush, onPRMerged, and onTagRelease events

## 🔧 Setup Instructions

### 1. Environment Configuration

Set the following environment variables in your `.env` file:

```bash
# Required: ARCANOS agent-control mode
DEPLOY_MODE=agent-control
OPENAI_API_KEY=your-openai-api-key-here

# GitHub Integration (Required for full functionality)
GITHUB_TOKEN=your-github-token-here
GITHUB_WEBHOOK_SECRET=your-webhook-secret-here
ENABLE_GITHUB_ACTIONS=true
GITHUB_INTEGRATION=true
ALLOW_WEBHOOKS=true

# Optional: Security and Rate Limiting
MAX_TOKENS_PER_REQUEST=4000
MAX_REQUESTS_PER_MINUTE=30
ALLOWED_MODELS=gpt-4,gpt-4-turbo,gpt-3.5-turbo

# Backend Access
ARCANOS_API_TOKEN=your-arcanos-api-token-here
DATABASE_URL=your-database-url-here
```

### 2. GitHub Repository Setup

#### Required Permissions
Your GitHub token must have the following permissions:
- **contents**: write
- **actions**: write  
- **issues**: read
- **pull_requests**: write
- **webhooks**: admin

#### Webhook Configuration
1. Go to your repository's Settings → Webhooks
2. Add a new webhook with:
   - **Payload URL**: `https://your-domain.com/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: Your `GITHUB_WEBHOOK_SECRET`
   - **Events**: Push, Pull requests, Releases

### 3. Starting ARCANOS

Use the agent-control entry point:

```bash
# Development
npm run dev:agent-control

# Production
npm run start:agent-control

# Or using the main entry point
npm run start:main
```

## 🎯 Core Features

### GitHub Webhook Handlers

#### 1. onPush Handler (`/webhooks/github`)
- **Trigger**: Repository push events
- **Actions**: 
  - Analyzes code changes with ARCANOS AI
  - Triggers `arcanos-code-analysis.yml` workflow if significant changes detected
  - Performs security and quality assessment

#### 2. onPRMerged Handler (`/webhooks/github`)
- **Trigger**: Pull request merge events
- **Actions**:
  - Evaluates merge impact with ARCANOS AI
  - Triggers `arcanos-deploy.yml` workflow for main/master branch merges
  - Manages deployment decisions

#### 3. onTagRelease Handler (`/webhooks/github`)
- **Trigger**: Tag creation and release events
- **Actions**:
  - Generates release documentation with ARCANOS AI
  - Triggers `arcanos-release.yml` workflow
  - Performs security validation before release

### GitHub Actions Workflows

#### Code Analysis Workflow (`arcanos-code-analysis.yml`)
```yaml
# Triggered by: Push events via ARCANOS webhook
# Capabilities:
- AI-powered code analysis
- Security vulnerability detection
- Performance optimization recommendations
- Automatic issue creation for critical findings
```

#### Deployment Workflow (`arcanos-deploy.yml`) 
```yaml
# Triggered by: PR merge events via ARCANOS webhook
# Capabilities:
- Pre-deployment AI analysis
- Deployment readiness validation
- Automated deployment with AI approval
- Deployment blocking for critical issues
```

#### Release Workflow (`arcanos-release.yml`)
```yaml
# Triggered by: Tag/release events via ARCANOS webhook  
# Capabilities:
- AI-generated release notes
- Security scanning and validation
- Release artifact generation
- Documentation updates
```

### Enhanced OpenAI SDK

The enhanced OpenAI service provides:

```typescript
// Modular, context-aware AI operations
import { arcanosOpenAI } from './services/enhanced-openai';

// Code analysis
const analysis = await arcanosOpenAI.analyzeCode(codeContent, 'security');

// Context-specific chat
const result = await arcanosOpenAI.chat(prompt, 'deployment_analysis', {
  maxTokens: 1500,
  temperature: 0.3
});

// Token-efficient batch processing
const results = await arcanosOpenAI.batchProcess(prompts, { maxConcurrent: 3 });
```

## 🔒 Security Features

### Rate Limiting
- Maximum tokens per request: 4,000 (configurable)
- Maximum requests per minute: 30 (configurable)
- Automatic rate limit enforcement

### Model Security
- Allowed models whitelist
- API key validation
- Signature verification for webhooks

### Token Optimization
- Intelligent prompt compression
- Context length management
- Cost-efficient batching

## 🧪 Testing

Run the integration test suite:

```bash
# Start ARCANOS in agent-control mode
npm run dev:agent-control

# In another terminal, run tests
node test-github-integration.js
```

### Test Coverage
- ✅ Server health and availability
- ✅ GitHub webhook endpoints
- ✅ Agent-control mode validation
- ✅ Webhook capability verification (onPush, onPRMerged, onTagRelease)
- ⚠️ Backend read/write (requires valid API token)
- ⚠️ OpenAI integration (requires valid API key)

## 📊 Monitoring and Observability

### Performance Endpoint
Check ARCANOS status and performance:
```bash
GET /performance
```

Returns:
```json
{
  "environment": "development",
  "deploymentMode": "agent-control", 
  "sleepMode": false,
  "memoryStatus": {...},
  "timestamp": "2025-07-29T10:12:55.721Z"
}
```

### Webhook Health Check
Verify GitHub integration:
```bash
GET /webhooks/github/health
```

Returns:
```json
{
  "status": "ok",
  "service": "GitHub webhook handler",
  "capabilities": ["onPush", "onPRMerged", "onTagRelease"]
}
```

## 🔄 Workflow Integration

### Automatic Triggers

1. **Code Push** → ARCANOS analyzes changes → Triggers code analysis workflow
2. **PR Merge** → ARCANOS evaluates impact → Triggers deployment workflow  
3. **Tag Release** → ARCANOS generates docs → Triggers release workflow

### Manual Triggers

Workflows can also be triggered manually via GitHub Actions with custom inputs:

```bash
# Trigger code analysis
gh workflow run arcanos-code-analysis.yml -f commit_sha=abc123

# Trigger deployment
gh workflow run arcanos-deploy.yml -f merge_commit_sha=def456 -f environment=staging

# Trigger release
gh workflow run arcanos-release.yml -f tag_name=v1.0.0
```

## 🚨 Troubleshooting

### Common Issues

1. **Webhook not receiving events**
   - Check webhook URL and secret configuration
   - Verify repository webhook settings
   - Ensure `ALLOW_WEBHOOKS=true`

2. **GitHub Actions not triggering**
   - Verify `GITHUB_TOKEN` has correct permissions
   - Check workflow files exist in `.github/workflows/`
   - Ensure `ENABLE_GITHUB_ACTIONS=true`

3. **OpenAI integration failures**
   - Validate `OPENAI_API_KEY` is correct
   - Check model permissions and availability
   - Review rate limiting settings

### Debug Mode

Enable debug logging:
```bash
DEBUG=arcanos:* npm run dev:agent-control
```

## 📚 API Reference

### Core Endpoints

- `GET /health` - Server health check
- `GET /performance` - Performance and status metrics
- `POST /ask` - AI chat completion
- `POST /webhooks/github` - GitHub webhook handler
- `GET /webhooks/github/health` - GitHub integration health

### GitHub Integration Endpoints

- `POST /api/github/trigger-workflow` - Manual workflow triggering
- `GET /api/github/workflows` - List available workflows  
- `GET /api/github/status` - GitHub integration status

---

## 🎉 Success Criteria

Your ARCANOS GitHub integration is working correctly when:

1. ✅ Server starts with "DEPLOY_MODE: agent-control"
2. ✅ GitHub webhook health check returns capabilities
3. ✅ Push events trigger code analysis
4. ✅ PR merges trigger deployment workflows
5. ✅ Releases trigger release workflows
6. ✅ ARCANOS AI provides analysis and decision making
7. ✅ Workflows execute based on AI recommendations

This completes the implementation of ARCANOS as a full backend controller with GitHub integration as specified in the requirements.
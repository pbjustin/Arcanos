# ARCANOS GitHub Module Registry

This document describes the GitHub integration module registry entry for the ARCANOS backend system. The module provides OpenAI SDK-compatible functions for GitHub repository management.

## 📋 Overview

The **ARCANOS:GITHUB** module provides a standardized interface for GitHub operations that can be used directly with OpenAI's function calling capabilities. It includes comprehensive audit tracing, versioning, and security features.

### Module Details

- **Name**: `ARCANOS:GITHUB`
- **Provider**: GitHub REST API v3
- **Version**: 1.0.0
- **Status**: Active
- **OpenAI SDK Compatibility**: v5.15.0

## 🔧 Configuration

### Environment Variables

The module requires the following environment variables:

```bash
# Required for GitHub API authentication
GITHUB_TOKEN=your_github_personal_access_token
GITHUB_USER=your_github_username_or_organization
```

### Token Validation

The `GITHUB_TOKEN` must match the pattern: `^(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{36}$`

## 🎯 Available Actions

The module provides four core GitHub actions:

### 1. createRepo
Creates a new GitHub repository.

**OpenAI Function**: `github_create_repo`

**Parameters**:
- `name` (required): Repository name
- `description` (optional): Repository description
- `private` (optional): Whether repository should be private (default: false)
- `auto_init` (optional): Initialize with README (default: true)

### 2. commitFile
Commits a file to a GitHub repository.

**OpenAI Function**: `github_commit_file`

**Parameters**:
- `owner` (required): Repository owner
- `repo` (required): Repository name
- `path` (required): File path in repository
- `content` (required): Base64-encoded file content
- `message` (required): Commit message
- `branch` (optional): Target branch (default: "main")

### 3. openPR
Opens a new pull request.

**OpenAI Function**: `github_open_pr`

**Parameters**:
- `owner` (required): Repository owner
- `repo` (required): Repository name
- `title` (required): Pull request title
- `head` (required): Source branch
- `body` (optional): Pull request description
- `base` (optional): Target branch (default: "main")
- `draft` (optional): Create as draft (default: false)

### 4. listIssues
Lists issues in a repository.

**OpenAI Function**: `github_list_issues`

**Parameters**:
- `owner` (required): Repository owner
- `repo` (required): Repository name
- `state` (optional): Issue state filter ("open", "closed", "all")
- `labels` (optional): Comma-separated label names
- `sort` (optional): Sort field ("created", "updated", "comments")
- `direction` (optional): Sort direction ("asc", "desc")
- `per_page` (optional): Results per page (1-100, default: 30)

## 🔗 OpenAI SDK Integration

### Basic Usage

```typescript
import OpenAI from 'openai';
import { moduleRegistryService } from './services/moduleRegistryService.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Get GitHub tools
const githubTools = moduleRegistryService.createOpenAIToolsConfig(['ARCANOS:GITHUB']);

// Use with chat completions
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [
    { 
      role: 'user', 
      content: 'Create a new repository called "my-awesome-project" with a README' 
    }
  ],
  tools: githubTools,
  tool_choice: 'auto'
});
```

### Function Calling Response

When the AI decides to use GitHub functions, the response will include `tool_calls`:

```json
{
  "choices": [
    {
      "message": {
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function",
            "function": {
              "name": "github_create_repo",
              "arguments": "{\"name\":\"my-awesome-project\",\"description\":\"An awesome project\",\"auto_init\":true}"
            }
          }
        ]
      }
    }
  ]
}
```

## 🔒 Security & Audit Features

### Authentication
- Token-based authentication with GitHub Personal Access Tokens
- Token validation using regex patterns
- Secure token handling and sanitization in logs

### Rate Limiting
- **createRepo**: 1,000 requests per hour
- **commitFile**: 5,000 requests per hour
- **openPR**: 1,000 requests per hour
- **listIssues**: 5,000 requests per hour

### Audit Logging
The module includes comprehensive audit capabilities:

- **Enabled**: Request tracing and response logging
- **Retention**: 90 days
- **Token Sanitization**: Automatic removal of sensitive data from logs
- **Metadata**: Includes timestamps, user IDs, request IDs, and response status

### Audit Fields
```json
[
  "action",
  "timestamp", 
  "user_id",
  "request_id",
  "parameters",
  "response_status",
  "rate_limit_remaining"
]
```

## 📦 Module Registry Service

### Loading the Registry

```typescript
import { moduleRegistryService } from './services/moduleRegistryService.js';

// Load registry
const registry = moduleRegistryService.getRegistry();

// Get GitHub module
const githubModule = moduleRegistryService.getGitHubModule();

// Validate environment
const envCheck = moduleRegistryService.validateModuleEnvironment('ARCANOS:GITHUB');
```

### Environment Validation

```typescript
const validation = moduleRegistryService.validateModuleEnvironment('ARCANOS:GITHUB');

if (!validation.valid) {
  console.log('Missing:', validation.missing);
  console.log('Invalid:', validation.invalid);
}
```

### Statistics

```typescript
const stats = moduleRegistryService.getModuleStats();
// Returns: total_modules, active_modules, total_actions, providers, categories
```

## 🧪 Testing

### Running Tests

```bash
# Test the module registry
npm run test:registry

# Demo the GitHub module
npm run demo:github

# Build and test everything
npm run rebuild && npm run test:registry
```

### Test Coverage

The module includes comprehensive tests for:

- ✅ Registry loading and validation
- ✅ Module structure verification
- ✅ Required actions presence
- ✅ Environment variable configuration
- ✅ OpenAI SDK compatibility
- ✅ Function parameter validation
- ✅ Tools configuration generation
- ✅ Audit configuration verification

## 🔄 Versioning

### Current Version: 1.0.0

**Compatibility**:
- **Min ARCANOS Version**: 1.4.0
- **Max ARCANOS Version**: 2.0.0
- **API Version**: v3 (GitHub REST API)

### Changelog

**v1.0.0** (2025-01-26):
- Initial implementation
- Added core GitHub actions (createRepo, commitFile, openPR, listIssues)
- OpenAI SDK compatibility
- Audit tracing support
- Environment validation
- Rate limiting configuration

## 🔍 Monitoring

### Health Checks
- **Endpoint**: `/repos/{owner}/{repo}`
- **Metrics**: Performance tracking enabled
- **Error Reporting**: Comprehensive error logging

### Performance Tracking
- Request duration monitoring
- Success/failure rate tracking
- Rate limit consumption monitoring

## 📚 File Structure

```
src/
├── config/
│   └── modules-registry.json          # Main registry configuration
├── types/
│   └── moduleRegistry.ts              # TypeScript definitions
├── services/
│   ├── moduleRegistryService.ts       # Registry service
│   └── githubModuleIntegration.ts     # Integration examples
└── tests/
    └── test-module-registry.js        # Comprehensive tests
```

## 🚀 Getting Started

1. **Install dependencies**: `npm install`
2. **Set environment variables**: Configure `GITHUB_TOKEN` and `GITHUB_USER`
3. **Build project**: `npm run build`
4. **Test module**: `npm run test:registry`
5. **Run demo**: `npm run demo:github`

The GitHub module is now ready for integration with ARCANOS AI workflows and OpenAI function calling capabilities!
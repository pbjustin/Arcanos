# AI Patch System Documentation

## Overview

The AI Patch System is a backend service that enables dynamic content management with Git integration. It allows the AI to accept any content or code block dynamically generated via OpenAI SDK output, save it to task-based filenames, and commit it to the repository with proper version control.

## Features

### Core Functionality
- ✅ **Dynamic Content Acceptance**: Accepts any content type from OpenAI SDK output
- ✅ **Task-Based Filename Generation**: Automatically saves to files like `game_guide.md`, `ai_patch_notes.md`, `data_patch.json`
- ✅ **Git Integration**: Stages, commits, and pushes files to the main branch
- ✅ **SHA Tracking**: Returns Git SHA for successful commits
- ✅ **Error Handling**: Comprehensive logging to `/logs/patch_failures.log`
- ✅ **Retry Mechanism**: Automatic retry queue processing with exponential backoff
- ✅ **OpenAI SDK Compatibility**: Full integration with existing OpenAI workflows

### API Endpoints

#### POST /ai-patch
Creates a new AI patch with dynamic content.

**Request Body:**
```json
{
  "content": "# AI-Generated Content\nThis is dynamic content from OpenAI SDK...",
  "filename": "game_guide.md",
  "taskDescription": "Generate comprehensive game strategy guide"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "AI patch processed successfully",
  "timestamp": "2025-07-30T08:53:43.501Z",
  "data": {
    "sha": "abc123def456",
    "filePath": "/path/to/game_guide.md",
    "timestamp": "2025-07-30T08:53:43.501Z",
    "filename": "game_guide.md"
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "AI patch failed",
  "timestamp": "2025-07-30T08:53:43.501Z",
  "details": "Git operation failed: Authentication required"
}
```

#### GET /ai-patch/status
Retrieves the current system status and retry queue information.

**Response:**
```json
{
  "success": true,
  "message": "AI patch system status retrieved",
  "timestamp": "2025-07-30T08:53:47.788Z",
  "data": {
    "retryQueue": {
      "queueLength": 2,
      "items": [
        {
          "filename": "game_guide.md",
          "attemptCount": 1,
          "lastAttempt": "2025-07-30T08:53:43.364Z",
          "originalTimestamp": "2025-07-30T08:53:43.364Z"
        }
      ]
    },
    "lastSuccess": {
      "filename": "ai_patch_notes.md",
      "sha": "def456ghi789",
      "timestamp": "2025-07-30T08:50:00.000Z"
    },
    "lastError": {
      "filename": "data_patch.json",
      "error": "Git operation failed",
      "timestamp": "2025-07-30T08:53:47.650Z"
    }
  }
}
```

#### POST /ai-patch/retry
Manually triggers retry queue processing.

**Response:**
```json
{
  "success": true,
  "message": "Retry queue processed",
  "timestamp": "2025-07-30T08:54:00.000Z",
  "data": {
    "queueLength": 1,
    "items": []
  }
}
```

## System Architecture

### Service Components

1. **AIPatchSystemService** (`src/services/ai-patch-system.ts`)
   - Main service class handling all patch operations
   - File operations and Git integration
   - Retry queue management

2. **API Routes** (`src/routes/ai.ts`)
   - REST endpoints for patch operations
   - Status monitoring and manual retry triggers

3. **Cron Integration** (`src/services/cron-worker.ts`)
   - Automatic retry processing every 10 minutes
   - AI-controlled scheduling for optimal performance

### File Operations

The system handles the complete file lifecycle:

1. **Content Processing**: Accepts any string content from OpenAI SDK
2. **Local File Creation**: Saves content to specified filename in repository root
3. **Git Staging**: Uses GitHub API for atomic commit operations
4. **Commit Generation**: Creates timestamped commit messages
5. **Push to Main**: Pushes directly to the main branch
6. **SHA Confirmation**: Returns commit SHA for verification

### Commit Message Format

All commits use the standardized format:
```
AI patch update - [filename] - [datetime] - [task description]
```

Example:
```
AI patch update - game_guide.md - 07/30/2025, 08:53 - Generate comprehensive game strategy guide
```

### Error Handling and Retry Logic

#### Error Logging
- All failures are logged to `/logs/patch_failures.log`
- Structured logging with timestamp, filename, and error details
- Memory storage for system status tracking

#### Retry Queue
- Failed patches are automatically queued for retry
- Maximum 3 retry attempts per patch
- 5-minute minimum delay between retry attempts
- Rate limiting protection to avoid GitHub API abuse

#### Retry Processing
- Automatic processing via cron worker every 10 minutes
- Manual processing via `/ai-patch/retry` endpoint
- AI-controlled scheduling for optimal resource usage

## Configuration

### Environment Variables

```bash
# Required for Git operations
GITHUB_TOKEN=your_github_token_here
GITHUB_OWNER=your_github_username
GITHUB_REPO=your_repository_name

# Optional database for persistence
DATABASE_URL=your_database_url
```

### GitHub Token Permissions

The GitHub token requires the following permissions:
- `repo`: Full repository access for file operations
- `contents:write`: Create and update file contents
- `metadata:read`: Read repository metadata

## Integration with OpenAI SDK

The AI Patch System is designed for seamless integration with OpenAI SDK workflows:

### Example Usage in OpenAI Workflow

```javascript
import { createAIPatch } from './src/services/ai-patch-system';

// After OpenAI generates content
const openaiResponse = await openai.chat.completions.create({
  model: "gpt-4",
  messages: [{ role: "user", content: "Generate a game guide" }]
});

// Create patch with AI-generated content
const patchResult = await createAIPatch(
  openaiResponse.choices[0].message.content,
  'game_guide.md',
  'AI-generated game strategy guide'
);

if (patchResult.success) {
  console.log(`Patch created successfully: ${patchResult.sha}`);
} else {
  console.log(`Patch queued for retry: ${patchResult.error}`);
}
```

### Content Type Examples

The system supports various content types:

**Markdown Documentation:**
```markdown
# AI-Generated Game Guide
## Strategies and Tips
- Character builds
- Resource management
```

**JSON Data:**
```json
{
  "version": "1.0.0",
  "game_data": {
    "characters": [],
    "items": []
  }
}
```

**Code Files:**
```javascript
// AI-generated utility functions
function processGameData(data) {
  return data.filter(item => item.active);
}
```

## Testing

### Unit Tests
Run the comprehensive test suite:
```bash
npx ts-node tests/test-ai-patch-system.ts
```

### Integration Testing
Start the development server and test API endpoints:
```bash
npm run dev
curl -X GET "http://localhost:8080/ai-patch/status"
```

### Demo Script
Run the full demonstration:
```bash
./demo-ai-patch-system.sh
```

## Monitoring and Maintenance

### System Status Monitoring
- Use `/ai-patch/status` endpoint for real-time status
- Monitor retry queue length and error patterns
- Track successful patch creation rates

### Log Management
- Patch failures logged to `/logs/patch_failures.log`
- Successful operations logged to `/logs/patch_success.log`
- Regular log rotation recommended for production

### Performance Optimization
- Rate limiting prevents GitHub API abuse
- Memory-efficient retry queue management
- Optimized cron scheduling for minimal resource usage

## Security Considerations

### Token Security
- GitHub tokens stored as environment variables
- No tokens logged in error messages or status responses
- Secure token rotation recommended

### Content Validation
- Input validation for filename and content parameters
- Path traversal protection for file operations
- Content size limits to prevent abuse

### Access Control
- API endpoints protected by existing authentication middleware
- Cron operations run with system-level permissions
- Git operations isolated to repository scope

## Production Deployment

### Prerequisites
1. Valid GitHub token with repository permissions
2. Repository access for file operations
3. Sufficient disk space for local file operations
4. Network access to GitHub API

### Environment Setup
```bash
# Set required environment variables
export GITHUB_TOKEN="your_token_here"
export GITHUB_OWNER="your_username"
export GITHUB_REPO="your_repository"

# Start the service
npm run start
```

### Health Checks
The system provides built-in health monitoring:
- API endpoint availability
- GitHub API connectivity
- Retry queue status
- Error rate monitoring

## Troubleshooting

### Common Issues

**"No GitHub token found"**
- Solution: Set GITHUB_TOKEN environment variable

**"Git operation failed: Not Found"**
- Solution: Verify repository name and token permissions

**"Abuse detection mechanism triggered"**
- Solution: Rate limiting active, retries will resume automatically

**"Failed to get commit SHA"**
- Solution: Check GitHub API response format and token permissions

### Debug Mode
Enable verbose logging for troubleshooting:
```bash
export DEBUG_AI_PATCH=true
npm run dev
```

## API Reference Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ai-patch` | POST | Create new AI patch |
| `/ai-patch/status` | GET | Get system status |
| `/ai-patch/retry` | POST | Trigger retry processing |

All endpoints return standardized JSON responses with success/error indicators and detailed timestamps.
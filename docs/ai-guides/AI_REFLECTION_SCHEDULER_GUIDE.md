# AI Reflection Scheduler Documentation

The AI Reflection Scheduler provides automated self-reflection capabilities for the ARCANOS system, triggering reflections every 40 minutes and managing long-term memory storage.

## Features

- **Automated Reflections**: Triggers AI self-reflection every 40 minutes
- **Persistent Storage**: Stores reflections in both memory and GitHub repository
- **Memory Management**: Automatically prunes reflections older than 7 days
- **OpenAI SDK Integration**: Uses standardized OpenAI completions API
- **Graceful Fallbacks**: Works in mock mode without API keys

## Usage

### Automatic Startup

The scheduler automatically starts when the main application loads:

```typescript
import { aiReflectionScheduler } from './src/ai-reflection-scheduler';

// Scheduler starts automatically unless AUTO_START_REFLECTION_SCHEDULER=false
```

### Manual Control

```typescript
import { aiReflectionScheduler } from './src/ai-reflection-scheduler';

// Start the scheduler
aiReflectionScheduler.start();

// Stop the scheduler
aiReflectionScheduler.stop();

// Force a reflection cycle
await aiReflectionScheduler.forceReflection();

// Check status
const status = aiReflectionScheduler.getStatus();
console.log(status); // { isRunning: boolean, nextRunIn?: number }
```

### Direct API Usage

```typescript
import { reflect } from './src/services/ai';
import { writeToRepo } from './src/utils/git';
import { pruneOldReflections } from './src/utils/cleanup';

// Manual reflection
const snapshot = await reflect({
  label: 'manual_reflection_001',
  persist: true,
  includeStack: true,
  commitIfChanged: true,
  targetPath: 'ai_outputs/reflections/'
});

// Write to repository
await writeToRepo(snapshot, {
  path: 'ai_outputs/reflections/',
  commitMessage: '🧠 Manual Reflection Update'
});

// Clean up old reflections
await pruneOldReflections({
  directory: 'ai_outputs/reflections/',
  olderThanDays: 7
});
```

## Configuration

### Environment Variables

- `OPENAI_API_KEY`: Required for AI reflections (falls back to mock mode if missing)
- `GITHUB_TOKEN`: Required for repository writes (skips if missing)
- `GITHUB_OWNER`: Repository owner (defaults to 'pbjustin')
- `GITHUB_REPO`: Repository name (defaults to 'Arcanos')
- `AUTO_START_REFLECTION_SCHEDULER`: Set to 'false' to disable auto-start

### Reflection Options

```typescript
interface ReflectionOptions {
  label: string;           // Unique identifier for the reflection
  persist?: boolean;       // Save to persistent storage (default: false)
  includeStack?: boolean;  // Include system state info (default: false)
  commitIfChanged?: boolean; // Commit to repository if content changed (default: false)
  targetPath?: string;     // Storage path (default: 'ai_outputs/reflections/')
}
```

## Integration

The scheduler integrates seamlessly with existing ARCANOS components:

- **AI Services**: Uses `CoreAIService` for OpenAI API calls
- **Memory System**: Leverages existing memory storage and database services
- **GitHub Integration**: Uses existing `githubPushStable` utilities
- **Logging**: Integrates with existing service logger system
- **Self-Reflection**: Extends existing `SelfReflectionService`

## File Structure

```
src/
├── ai-reflection-scheduler.ts    # Main scheduler service
├── services/ai/
│   └── index.ts                  # AI reflection functions
├── utils/
│   ├── git.ts                    # Repository utilities
│   └── cleanup.ts                # Memory cleanup utilities
```

## Example Output

Reflections are stored as JSON files with the following structure:

```json
{
  "label": "auto_reflection_1703123456789",
  "timestamp": "2023-12-20T15:30:00.000Z",
  "reflection": "AI-generated reflection content...",
  "systemState": {
    "timestamp": "2023-12-20T15:30:00.000Z",
    "memoryUsage": { "rss": 123456, "heapTotal": 78910 },
    "uptime": 3600,
    "nodeVersion": "v18.17.0",
    "platform": "linux"
  },
  "targetPath": "ai_outputs/reflections/",
  "metadata": {
    "model": "gpt-4-turbo",
    "persist": true,
    "includeStack": true
  }
}
```

## Testing

Run the mock test to verify the implementation:

```bash
npm run build
AUTO_START_REFLECTION_SCHEDULER=false npx ts-node test-reflection-mock.ts
```

## Troubleshooting

### Common Issues

1. **OpenAI API Key Missing**: System runs in mock mode
2. **GitHub Token Missing**: Repository writes are skipped
3. **Database Unavailable**: Falls back to in-memory storage
4. **Build Errors**: Ensure all dependencies are installed with `npm install`

### Logs

The scheduler logs all activities with service-specific prefixes:

- `ℹ️ AIReflectionScheduler` - General information
- `✅ AIReflectionScheduler` - Successful operations
- `⚠️ AIReflectionScheduler` - Warnings
- `❌ AIReflectionScheduler` - Errors
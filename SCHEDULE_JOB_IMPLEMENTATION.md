# Schedule Job Implementation

This implementation ensures that all scheduled jobs explicitly define the target worker and fallback is never triggered.

## Changes Made

### 1. Added `scheduleJob` Function

A new `scheduleJob` function has been added to `src/services/execution-engine.ts` that:

- Validates that the `worker` field exists in the `value` parameter
- Ensures the `worker` field is a string
- Throws an error if the worker field is missing or invalid
- Returns a properly formatted `DispatchInstruction` object

### 2. Removed Fallback Behavior

The following fallback behaviors have been removed:

#### In Execution Engine (`src/services/execution-engine.ts`):
- Removed automatic fallback to 'defaultWorker' when worker is missing
- Added explicit error handling for missing worker fields in scheduled jobs

#### In AI Dispatcher (`src/services/ai-dispatcher.ts`):
- Removed fallback worker assignment for schedule instructions
- Changed behavior to drop instructions with missing workers instead of applying fallbacks

## Usage

```javascript
const { scheduleJob } = require('./dist/services/execution-engine');

// Correct usage - will succeed
const result = scheduleJob({
  key: 'scheduled_emails_worker',
  value: {
    worker: 'emailDispatcher',
    type: 'ondemand',
    timestamp: new Date().toISOString(),
    status: 'scheduled',
  },
  schedule: '@hourly',
  priority: 5,
});

// Incorrect usage - will throw error
const badResult = scheduleJob({
  key: 'bad_job',
  value: {
    // worker: 'missing', // Missing worker field
    type: 'ondemand',
  },
  schedule: '@daily',
});
// Error: Missing or invalid 'worker' field for scheduled job: bad_job
```

## Validation Rules

1. The `value.worker` field must exist
2. The `value.worker` field must be a string
3. No fallback workers are used - all jobs must explicitly specify their target worker
4. Invalid schedule instructions are dropped rather than fixed with fallbacks

This ensures explicit worker assignment and prevents accidental fallback usage.
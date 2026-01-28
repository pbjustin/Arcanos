# Rate Limiting Fix for Backend GitHub API Issues

## Problem

If your backend server is pulling from a live GitHub repository, it may be making frequent GitHub API calls that hit GitHub's rate limits. When GitHub returns 429 errors to the backend, the backend cascades these errors to the CLI agent, causing continuous 429 errors.

## Solution Implemented

### 1. Exponential Backoff for 429 Errors

The CLI agent now implements exponential backoff when receiving 429 errors:

- **First 429**: Waits 1x the normal interval before retrying
- **Second consecutive 429**: Waits 2x the interval (capped at 60s)
- **Third+ consecutive 429**: Waits up to 60 seconds before retrying
- **Respects Retry-After headers**: If the backend sends a `Retry-After` header, the CLI will wait at least that long

This prevents the CLI agent from overwhelming the backend with retry requests.

### 2. Configurable Intervals

Both heartbeat and command poll intervals are now configurable via environment variables:

- **`DAEMON_HEARTBEAT_INTERVAL_SECONDS`** (default: 60s, was 30s)
- **`DAEMON_COMMAND_POLL_INTERVAL_SECONDS`** (default: 30s, was 10s)

The defaults have been increased to reduce backend load.

### 3. Default Intervals

The default intervals have been increased to reduce backend load:
- Heartbeat: 60 seconds (was 30s)
- Command poll: 30 seconds (was 10s)

This reduces the request frequency from ~4 requests/minute to ~2 requests/minute.

## Usage

### Option 1: Use Default (Recommended)

The default intervals are already conservative. Just start the CLI:

```bash
cd daemon-python
python -m arcanos.cli
```

### Option 2: Custom Intervals via Environment Variables

If you need different intervals, set them before starting:

```bash
# On macOS/Linux:
export DAEMON_HEARTBEAT_INTERVAL_SECONDS=120  # 2 minutes
export DAEMON_COMMAND_POLL_INTERVAL_SECONDS=60  # 1 minute
python -m arcanos.cli

# On Windows PowerShell:
# $env:DAEMON_HEARTBEAT_INTERVAL_SECONDS = "120"
# $env:DAEMON_COMMAND_POLL_INTERVAL_SECONDS = "60"
# python -m arcanos.cli
```

Or add to `.env` file:
```
DAEMON_HEARTBEAT_INTERVAL_SECONDS=120
DAEMON_COMMAND_POLL_INTERVAL_SECONDS=60
```

### Option 3: More Aggressive (Not Recommended)

If you need faster response times and your backend can handle it:

```bash
export DAEMON_HEARTBEAT_INTERVAL_SECONDS=30
export DAEMON_COMMAND_POLL_INTERVAL_SECONDS=10
python -m arcanos.cli
```

## Trade-offs

**Longer Intervals (Recommended for Rate-Limited Backends):**
- ✅ Fewer requests = less rate limiting
- ✅ Lower backend load
- ✅ More stable operation
- ❌ Commands may take longer to be received
- ❌ Backend may consider CLI "offline" if heartbeat is too long

**Shorter Intervals (Only if Backend Can Handle It):**
- ✅ Faster command delivery
- ✅ More responsive
- ❌ More requests = higher chance of rate limiting
- ❌ Higher backend load

## Monitoring

After restarting the CLI agent with the new code, monitor the error logs:

```bash
# On macOS/Linux:
tail -f logs/errors.log

# On Windows PowerShell:
# Get-Content logs\errors.log -Tail 20 -Wait
```

You should see:
- Fewer 429 errors over time
- Increasing gaps between retries when 429s occur
- Backoff messages in debug logs (if enabled)

## Backend-Side Recommendations

While the CLI agent now handles rate limiting better, the backend should also:

1. **Use GitHub Personal Access Token (PAT)** - Increases rate limit from 60/hour to 5,000/hour
2. **Implement caching** - Cache GitHub API responses to reduce API calls
3. **Use webhooks instead of polling** - Reduces need for frequent API calls
4. **Implement backoff** - When backend receives 429 from GitHub, it should back off before retrying

## Verification

To verify the fix is working:

1. Start the CLI agent with the new code
2. Monitor error logs for 30-60 seconds
3. You should see:
   - Initial 429 errors (if backend is still rate-limited)
   - Increasing gaps between retries
   - Eventually, successful requests as backoff allows rate limits to reset

The exponential backoff ensures the CLI agent will automatically recover once the backend's rate limits reset.

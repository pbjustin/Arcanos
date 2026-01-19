# ARCANOS Daemon Purge Sequence

## Overview

The ARCANOS Daemon Purge Sequence is a system administration tool designed to detect, audit, and manage background processes and services. It provides a safe, structured approach to identifying unauthorized daemons and maintaining system health.

## Features

- **Daemon Detection**: Scans for active Node.js, Python, Docker, PM2, and systemd processes
- **Process Auditing**: Identifies and logs all running background services
- **Startup Script Analysis**: Audits systemd, init.d, and user autostart configurations
- **Cache Management**: Cleans PM2 logs and Docker system resources
- **Health Monitoring**: Checks system service status and reports health metrics
- **Safety First**: Includes dry-run mode and conservative defaults to prevent system damage

## Usage

### Command Line (Bash Script)

```bash
# Run in dry-run mode (recommended for first use)
npm run daemon:purge:dry-run

# Or directly:
bash scripts/daemon-purge.sh --dry-run

# Run actual purge (use with caution)
npm run daemon:purge

# Or directly:
bash scripts/daemon-purge.sh
```

### TypeScript API

```typescript
import { executeDaemonPurge, validateAuthorizedServices } from './src/commands/arcanos/daemonPurge';

// Validate configuration first
const validation = validateAuthorizedServices();
if (!validation.valid) {
  console.error('Configuration errors:', validation.errors);
  process.exit(1);
}

// Execute in dry-run mode
const result = await executeDaemonPurge({ dryRun: true, verbose: true });

if (result.success) {
  console.log('Purge completed successfully');
  console.log('Scan log:', result.scanLog);
  console.log('Clean log:', result.cleanLog);
} else {
  console.error('Purge failed:', result.error);
}
```

### Node.js CLI

```bash
# Using the CLI wrapper
node scripts/daemon-purge-cli.js --dry-run --verbose
```

## Configuration

The daemon purge system uses `config/authorized-services.json` to define which processes and services are considered authorized:

```json
{
  "authorizedProcesses": [
    "node",
    "npm",
    "nginx",
    "postgresql",
    "postgres",
    "redis-server",
    "systemd",
    "sshd",
    "cron",
    "dockerd",
    "containerd"
  ],
  "authorizedServices": [
    "nginx",
    "postgresql",
    "redis",
    "docker",
    "ssh",
    "cron"
  ],
  "pm2Ecosystem": "ecosystem.config.js",
  "allowedDockerImages": [
    "postgres",
    "redis",
    "nginx"
  ]
}
```

### Customizing Authorized Services

Edit `config/authorized-services.json` to add or remove authorized processes:

1. **authorizedProcesses**: Process names that should not be flagged as suspicious
2. **authorizedServices**: System services that are approved to run
3. **pm2Ecosystem**: Path to PM2 ecosystem configuration
4. **allowedDockerImages**: Docker images that are authorized to run

## Purge Sequence Steps

### 1. Detect Active Daemons
- Scans for Node.js, Python, Docker, PM2, and systemd processes
- Logs all detected processes to `logs/daemon-scan.log`
- Identifies running Docker containers
- Lists PM2 managed processes

### 2. Terminate Rogue Processes
- Reviews detected processes against authorized list
- **Safety Note**: Automatic termination is disabled by default
- Requires manual review and intervention for actual termination
- Prevents accidental system damage

### 3. Audit Startup Scripts
- Checks `/etc/systemd/system/*.service` files
- Reviews `/etc/init.d/` scripts
- Examines `~/.config/autostart/` user startup items
- Audits PM2 startup configuration
- Identifies Docker Compose files

### 4. Clear Caches & Lock Files
- Flushes PM2 logs (`pm2 flush`)
- Cleans Docker system resources (`docker system prune -f`)
- Notes: Lock file clearing requires elevated privileges
- Conservative approach to prevent data loss

### 5. Rebuild Authorized Services
- Checks status of authorized services
- Provides commands for manual service restart
- Does not auto-restart to prevent production disruption
- Lists available restart commands for different service managers

### 6. Confirm System Health
- Checks for failed systemd services (`systemctl --failed`)
- Lists PM2 process status (`pm2 list`)
- Shows Docker container status (`docker ps`)
- Reports active Node.js processes
- Logs final system state to `logs/daemon-clean.log`

## Log Files

### daemon-scan.log
Contains detailed scan results including:
- All detected processes and their PIDs
- Docker container listings
- PM2 process information
- Systemd service status
- Startup script locations

### daemon-clean.log
Contains cleanup and health check results:
- Actions taken during purge
- Service status after cleanup
- System health metrics
- Final system state

## Safety Features

### 1. Dry-Run Mode
Always test with `--dry-run` first:
```bash
npm run daemon:purge:dry-run
```

This mode:
- Performs all detection and auditing
- Does NOT make any system changes
- Does NOT terminate processes
- Does NOT clear caches or restart services
- Generates logs for review

### 2. Configuration Validation
Before execution, the system validates:
- Configuration file exists
- Required fields are present
- JSON structure is valid
- Arrays are properly formatted

### 3. Conservative Defaults
- No automatic process termination
- Manual intervention required for destructive operations
- Service restarts require explicit commands
- Lock file clearing requires elevated privileges

### 4. Timeout Protection
- 60-second timeout on script execution
- Prevents hanging on unresponsive operations
- Graceful error handling on timeout

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Security - Daemon Audit

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:

jobs:
  daemon-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run daemon scan (dry-run)
        run: npm run daemon:purge:dry-run
      
      - name: Upload scan logs
        uses: actions/upload-artifact@v3
        with:
          name: daemon-scan-logs
          path: logs/daemon-*.log
```

## Testing

Run the daemon purge test suite:

```bash
# Run all tests
npm test daemon-purge.test.ts

# Run with verbose output
npm test daemon-purge.test.ts -- --verbose
```

The test suite includes:
- Configuration validation tests
- Dry-run execution tests
- Safety check verification
- Log file management tests
- Integration tests

## Troubleshooting

### Script Not Found Error
Ensure the script exists and is executable:
```bash
ls -la scripts/daemon-purge.sh
chmod +x scripts/daemon-purge.sh
```

### Configuration Not Found
Create or restore the configuration file:
```bash
mkdir -p config
cp config/authorized-services.json.example config/authorized-services.json
```

### Permission Denied
Some operations require elevated privileges:
```bash
# Run with sudo if needed
sudo npm run daemon:purge
```

### Logs Not Generated
Ensure logs directory exists and is writable:
```bash
mkdir -p logs
chmod 755 logs
```

## Security Considerations

1. **Audit Comments**: The TypeScript implementation includes `//audit` comments marking security-critical code paths
2. **Path Validation**: All file paths are validated to prevent directory traversal
3. **Command Injection**: Commands are constructed safely using parameterized execution
4. **Configuration Validation**: Input validation prevents malformed configuration
5. **Timeout Protection**: Prevents resource exhaustion from hanging operations

## Best Practices

1. **Always Test First**: Use `--dry-run` before actual execution
2. **Review Logs**: Examine `daemon-scan.log` before taking action
3. **Customize Config**: Update `authorized-services.json` for your environment
4. **Regular Audits**: Schedule periodic scans to detect anomalies
5. **Manual Verification**: Review flagged processes before termination
6. **Backup Config**: Keep copies of your authorized services configuration

## API Reference

### executeDaemonPurge(options)

Executes the daemon purge sequence.

**Parameters:**
- `options.dryRun` (boolean): Run without making changes (default: false)
- `options.verbose` (boolean): Enable verbose logging (default: false)

**Returns:**
- `Promise<DaemonPurgeResult>`: Object containing:
  - `success` (boolean): Whether execution succeeded
  - `message` (string): Human-readable result message
  - `scanLog` (string?): Contents of daemon-scan.log
  - `cleanLog` (string?): Contents of daemon-clean.log
  - `error` (string?): Error message if failed

### validateAuthorizedServices()

Validates the authorized services configuration.

**Returns:**
- Object containing:
  - `valid` (boolean): Whether configuration is valid
  - `errors` (string[]): Array of validation errors

## Contributing

When modifying the daemon purge system:

1. Maintain the safety-first approach
2. Add `//audit` comments for security-critical code
3. Update tests for new functionality
4. Document changes in this file
5. Test thoroughly in dry-run mode
6. Consider edge cases and failure scenarios

## License

MIT - See LICENSE file for details

/**
 * ARCANOS Daemon Purge Command
 * Executes the daemon purge sequence to detect and audit background processes
 * 
 * //audit: Security check - daemon purge affects system processes
 * //audit: Requires careful validation of authorized services list
 * //audit: Implements dry-run mode to prevent accidental system damage
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

interface DaemonPurgeOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

interface DaemonPurgeResult {
  success: boolean;
  message: string;
  scanLog?: string;
  cleanLog?: string;
  error?: string;
}

/**
 * Executes the daemon purge sequence
 * //audit: Main entry point - validates options before execution
 * //audit: Returns structured result with log paths
 * 
 * @param options - Configuration options for the purge sequence
 * @returns Promise with purge results
 */
export async function executeDaemonPurge(
  options: DaemonPurgeOptions = {}
): Promise<DaemonPurgeResult> {
  const { dryRun = false, verbose = false } = options;

  try {
    // //audit: Path validation to prevent directory traversal
    const scriptPath = path.join(process.cwd(), 'scripts', 'daemon-purge.sh');
    
    if (!existsSync(scriptPath)) {
      return {
        success: false,
        message: 'Daemon purge script not found',
        error: `Script not found at: ${scriptPath}`,
      };
    }

    // //audit: Command construction with safe parameters
    const command = dryRun 
      ? `bash ${scriptPath} --dry-run`
      : `bash ${scriptPath}`;

    if (verbose) {
      console.log(`Executing: ${command}`);
    }

    // //audit: Execute with timeout to prevent hanging
    const { stdout, stderr } = await execAsync(command, {
      timeout: 60000, // 60 second timeout
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
    });

    // Read log files if they exist
    const logsDir = path.join(process.cwd(), 'logs');
    const scanLogPath = path.join(logsDir, 'daemon-scan.log');
    const cleanLogPath = path.join(logsDir, 'daemon-clean.log');

    let scanLog: string | undefined;
    let cleanLog: string | undefined;

    // //audit: Safe file reading with error handling
    try {
      if (existsSync(scanLogPath)) {
        scanLog = readFileSync(scanLogPath, 'utf-8');
      }
    } catch (err) {
      console.warn('Could not read scan log:', err);
    }

    try {
      if (existsSync(cleanLogPath)) {
        cleanLog = readFileSync(cleanLogPath, 'utf-8');
      }
    } catch (err) {
      console.warn('Could not read clean log:', err);
    }

    return {
      success: true,
      message: 'Daemon purge sequence completed successfully',
      scanLog,
      cleanLog,
    };
  } catch (error) {
    // //audit: Error handling with safe error message extraction
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return {
      success: false,
      message: 'Daemon purge sequence failed',
      error: errorMessage,
    };
  }
}

/**
 * Validates the authorized services configuration
 * //audit: Configuration validation to ensure proper structure
 * 
 * @returns Validation result
 */
export function validateAuthorizedServices(): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const configPath = path.join(process.cwd(), 'config', 'authorized-services.json');

  try {
    if (!existsSync(configPath)) {
      errors.push(`Configuration file not found: ${configPath}`);
      return { valid: false, errors };
    }

    // //audit: JSON parsing with error handling
    const configContent = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    // //audit: Validate required fields
    if (!config.authorizedProcesses || !Array.isArray(config.authorizedProcesses)) {
      errors.push('Missing or invalid authorizedProcesses array');
    }

    if (!config.authorizedServices || !Array.isArray(config.authorizedServices)) {
      errors.push('Missing or invalid authorizedServices array');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errors.push(`Configuration validation error: ${errorMessage}`);
    return { valid: false, errors };
  }
}

/**
 * CLI entry point for daemon purge command
 * //audit: Command-line interface with argument parsing
 */
export async function daemonPurgeCommand(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose') || args.includes('-v');

  console.log('='.repeat(50));
  console.log('  ARCANOS Daemon Purge Sequence');
  console.log('='.repeat(50));
  console.log();

  if (dryRun) {
    console.log('Mode: DRY-RUN (no changes will be made)');
  }

  // //audit: Pre-execution validation
  const validation = validateAuthorizedServices();
  if (!validation.valid) {
    console.error('Configuration validation failed:');
    validation.errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  const result = await executeDaemonPurge({ dryRun, verbose });

  console.log();
  console.log('Result:', result.message);

  if (result.success) {
    console.log('Status: STABLE');
    
    if (result.scanLog) {
      console.log(`Scan log available at: logs/daemon-scan.log`);
    }
    
    if (result.cleanLog) {
      console.log(`Clean log available at: logs/daemon-clean.log`);
    }
    
    process.exit(0);
  } else {
    console.error('Error:', result.error);
    process.exit(1);
  }
}

// Export default for direct usage
export default executeDaemonPurge;

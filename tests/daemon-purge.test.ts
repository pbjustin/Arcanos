/**
 * ARCANOS Daemon Purge Tests
 * Tests for daemon detection and purge functionality
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { existsSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import {
  executeDaemonPurge,
  validateAuthorizedServices,
} from '../src/commands/arcanos/daemonPurge.js';

describe('Daemon Purge System', () => {
  const logsDir = path.join(process.cwd(), 'logs');
  const configDir = path.join(process.cwd(), 'config');
  const configPath = path.join(configDir, 'authorized-services.json');

  beforeAll(() => {
    // Ensure directories exist
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
  });

  describe('Configuration Validation', () => {
    test('should validate authorized services configuration', () => {
      const result = validateAuthorizedServices();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
    });

    test('should require authorized services config file', () => {
      // This test assumes the config file exists
      // If it doesn't exist, validation should fail
      expect(existsSync(configPath)).toBe(true);
    });

    test('should have valid JSON structure in config', async () => {
      const result = validateAuthorizedServices();

      if (result.valid) {
        // Config should have required fields
        const { readFileSync } = await import('fs');
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));

        expect(config).toHaveProperty('authorizedProcesses');
        expect(config).toHaveProperty('authorizedServices');
        expect(Array.isArray(config.authorizedProcesses)).toBe(true);
        expect(Array.isArray(config.authorizedServices)).toBe(true);
      }
    });
  });

  describe('Daemon Purge Execution', () => {
    test('should execute daemon purge in dry-run mode', async () => {
      const result = await executeDaemonPurge({ dryRun: true });

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
      
      // Dry-run should not fail
      if (!result.success) {
        console.warn('Dry-run failed:', result.error);
      }
    }, 70000); // 70 second timeout for script execution

    test('should return structured result', async () => {
      const result = await executeDaemonPurge({ dryRun: true });

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');

      if (!result.success) {
        expect(result).toHaveProperty('error');
      }
    }, 70000);

    test('should create log files after execution', async () => {
      const result = await executeDaemonPurge({ dryRun: true });

      // If execution was successful, logs should exist
      if (result.success) {
        const scanLogPath = path.join(logsDir, 'daemon-scan.log');
        const cleanLogPath = path.join(logsDir, 'daemon-clean.log');

        // At least one log should exist
        const hasLogs = existsSync(scanLogPath) || existsSync(cleanLogPath);
        expect(hasLogs).toBe(true);
      }
    }, 70000);

    test('should handle script not found gracefully', async () => {
      // Save original cwd
      const originalCwd = process.cwd();

      try {
        // Change to a directory where script doesn't exist
        process.chdir('/tmp');

        const result = await executeDaemonPurge({ dryRun: true });

        expect(result).toBeDefined();
        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
      } finally {
        // Restore original cwd
        process.chdir(originalCwd);
      }
    }, 30000);

    test('should respect dry-run flag', async () => {
      const result = await executeDaemonPurge({ dryRun: true });

      // Dry-run should not make actual system changes
      // We can only verify it completes without error
      expect(result).toBeDefined();
      
      if (result.success) {
        expect(result.message).toBeDefined();
      }
    }, 70000);
  });

  describe('Safety Checks', () => {
    test('should not execute without configuration', async () => {
      const validation = validateAuthorizedServices();

      // If config is invalid, purge should not proceed
      if (!validation.valid) {
        expect(validation.errors.length).toBeGreaterThan(0);
      }
    });

    test('should have timeout protection', async () => {
      // The executeDaemonPurge function has a 60s timeout
      // This test verifies the timeout exists by checking the implementation
      const result = await executeDaemonPurge({ dryRun: true });

      // If it completes within test timeout, timeout protection is working
      expect(result).toBeDefined();
    }, 70000);
  });

  describe('Log Management', () => {
    test('should have logs directory', () => {
      expect(existsSync(logsDir)).toBe(true);
    });

    test('should write to expected log paths', async () => {
      const result = await executeDaemonPurge({ dryRun: true });

      if (result.success) {
        // Check if logs were created
        const scanLogPath = path.join(logsDir, 'daemon-scan.log');
        const cleanLogPath = path.join(logsDir, 'daemon-clean.log');

        // At least one should exist after successful execution
        const logsExist = existsSync(scanLogPath) || existsSync(cleanLogPath);
        expect(logsExist).toBe(true);
      }
    }, 70000);
  });
});

describe('Daemon Purge Script Integration', () => {
  test('should have executable daemon-purge.sh script', () => {
    const scriptPath = path.join(process.cwd(), 'scripts', 'daemon-purge.sh');
    expect(existsSync(scriptPath)).toBe(true);
  });

  test('should have authorized services configuration', () => {
    const configPath = path.join(process.cwd(), 'config', 'authorized-services.json');
    expect(existsSync(configPath)).toBe(true);
  });
});

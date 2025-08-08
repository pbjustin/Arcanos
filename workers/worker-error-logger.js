#!/usr/bin/env node
/**
 * Worker Error Logger
 * Catches MemoryKeyFormatMismatch errors and logs them
 */
import fs from 'fs';
import path from 'path';
import { logEvent } from '../memory/logEvent.js';

export const id = 'worker-error-logger';
export const description = 'Logs worker schema errors to logs/error-log.txt';

class MemoryKeyFormatMismatch extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryKeyFormatMismatch';
  }
}

function validatePatternKeys(schema) {
  if (!schema) return;
  const invalid = Object.keys(schema).filter(k => !/^pattern_.+/.test(k));
  if (invalid.length) {
    throw new MemoryKeyFormatMismatch(`Invalid schema keys: ${invalid.join(', ')}`);
  }
}

export async function run(input = {}) {
  const logPath = path.resolve('logs', 'error-log.txt');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    validatePatternKeys(input.schema);
    await logEvent(id);
    return { success: true, worker: id, timestamp: new Date().toISOString() };
  } catch (error) {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${error.name}: ${error.message}\n`);
    if (error.name === 'MemoryKeyFormatMismatch') {
      return { success: false, error: error.message, worker: id };
    }
    throw error;
  }
}

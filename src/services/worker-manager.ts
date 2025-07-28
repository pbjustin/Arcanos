// Worker Management Utilities
// Unified interface for worker validation and dispatch

import { workerRegistry } from './unified-worker-registry';

/** Validate worker name - only allow alphanumeric, underscore and hyphen */
export function isValidWorker(name: string): boolean {
  return workerRegistry.validateWorker(name);
}

/**
 * Register a worker if valid and not already registered
 */
export function registerWorker(name: string, handler: any, metadata?: any): void {
  if (!isValidWorker(name)) {
    console.warn(`Rejected worker: ${name}`);
    return;
  }
  
  workerRegistry.registerWorker(name, handler, metadata);
}

/**
 * Dispatch a worker job safely by preventing overlapping dispatches
 */
export async function safeDispatch(workerType: string, payload?: any): Promise<void> {
  const result = await workerRegistry.dispatchWorker(workerType, payload);
  if (!result.success) {
    throw new Error(result.error || 'Worker dispatch failed');
  }
}


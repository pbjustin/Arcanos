/**
 * Unified Worker Registry System
 * Consolidates worker registration, validation, and dispatch logic
 */

import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('WorkerRegistry');

export interface WorkerMetadata {
  type: 'onDemand' | 'recurring' | 'cron' | 'logic';
  endpoint?: string;
  interval?: string;
  mode?: string;
  description?: string;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  retryCount: number;
  maxRetries: number;
}

export interface WorkerHandler {
  (payload?: any): Promise<void> | void;
}

export interface RegisteredWorker {
  name: string;
  handler: WorkerHandler;
  metadata: WorkerMetadata;
}

class UnifiedWorkerRegistry {
  private workers: Map<string, RegisteredWorker> = new Map();
  private activeWorkers: Set<string> = new Set();
  private dispatchLocks: Map<string, boolean> = new Map();

  /**
   * Validate worker name - only allow alphanumeric, underscore and hyphen
   */
  validateWorker(name: string): boolean {
    if (!name || typeof name !== 'string') {
      return false;
    }
    return /^[a-zA-Z0-9_-]+$/.test(name);
  }

  /**
   * Register a worker with validation and metadata
   */
  registerWorker(
    name: string,
    handler: WorkerHandler,
    metadata: Partial<WorkerMetadata> = {}
  ): boolean {
    if (!this.validateWorker(name)) {
      logger.warning('Invalid worker name rejected', { name });
      return false;
    }

    if (this.workers.has(name)) {
      logger.warning('Worker already registered', { name });
      return false;
    }

    const fullMetadata: WorkerMetadata = {
      type: 'onDemand',
      enabled: true,
      retryCount: 0,
      maxRetries: 3,
      ...metadata
    };

    const worker: RegisteredWorker = {
      name,
      handler,
      metadata: fullMetadata
    };

    this.workers.set(name, worker);
    this.activeWorkers.add(name);
    this.dispatchLocks.set(name, false);

    logger.info('Worker registered successfully', { 
      name, 
      type: fullMetadata.type,
      enabled: fullMetadata.enabled 
    });

    return true;
  }

  /**
   * Get worker by name
   */
  getWorker(name: string): RegisteredWorker | undefined {
    return this.workers.get(name);
  }

  /**
   * Get worker handler function
   */
  getWorkerHandler(name: string): WorkerHandler | undefined {
    const worker = this.workers.get(name);
    return worker?.handler;
  }

  /**
   * Get all registered worker names
   */
  getWorkerNames(): string[] {
    return Array.from(this.workers.keys());
  }

  /**
   * Get workers by type
   */
  getWorkersByType(type: WorkerMetadata['type']): RegisteredWorker[] {
    return Array.from(this.workers.values()).filter(
      worker => worker.metadata.type === type
    );
  }

  /**
   * Get enabled workers
   */
  getEnabledWorkers(): RegisteredWorker[] {
    return Array.from(this.workers.values()).filter(
      worker => worker.metadata.enabled
    );
  }

  /**
   * Update worker metadata
   */
  updateWorkerMetadata(name: string, metadata: Partial<WorkerMetadata>): boolean {
    const worker = this.workers.get(name);
    if (!worker) {
      logger.warning('Cannot update metadata for non-existent worker', { name });
      return false;
    }

    worker.metadata = { ...worker.metadata, ...metadata };
    logger.info('Worker metadata updated', { name, metadata });
    return true;
  }

  /**
   * Check if worker is currently locked (dispatch in progress)
   */
  isWorkerLocked(name: string): boolean {
    return this.dispatchLocks.get(name) || false;
  }

  /**
   * Lock worker to prevent concurrent dispatches
   */
  lockWorker(name: string): boolean {
    if (this.isWorkerLocked(name)) {
      return false;
    }
    this.dispatchLocks.set(name, true);
    return true;
  }

  /**
   * Unlock worker after dispatch completion
   */
  unlockWorker(name: string): void {
    this.dispatchLocks.set(name, false);
  }

  /**
   * Safe dispatch with locking and error handling
   */
  async dispatchWorker(name: string, payload?: any): Promise<{ success: boolean; error?: string }> {
    const worker = this.workers.get(name);
    if (!worker) {
      logger.error('Cannot dispatch non-existent worker', { name });
      return { success: false, error: 'Worker not found' };
    }

    if (!worker.metadata.enabled) {
      logger.warning('Cannot dispatch disabled worker', { name });
      return { success: false, error: 'Worker disabled' };
    }

    if (!this.lockWorker(name)) {
      logger.warning('Worker dispatch already in progress', { name });
      return { success: false, error: 'Worker busy' };
    }

    try {
      logger.info('Dispatching worker', { name, hasPayload: !!payload });
      await worker.handler(payload);
      
      // Update metadata
      this.updateWorkerMetadata(name, {
        lastRun: new Date(),
        retryCount: 0
      });

      logger.success('Worker dispatch completed', { name });
      return { success: true };

    } catch (error: any) {
      logger.error('Worker dispatch failed', error, { name });
      
      // Update retry count
      const currentRetries = worker.metadata.retryCount + 1;
      this.updateWorkerMetadata(name, {
        retryCount: currentRetries
      });

      return { success: false, error: error.message };
    } finally {
      this.unlockWorker(name);
    }
  }

  /**
   * Unregister a worker
   */
  unregisterWorker(name: string): boolean {
    if (!this.workers.has(name)) {
      return false;
    }

    this.workers.delete(name);
    this.activeWorkers.delete(name);
    this.dispatchLocks.delete(name);

    logger.info('Worker unregistered', { name });
    return true;
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalWorkers: number;
    enabledWorkers: number;
    lockedWorkers: number;
    workersByType: Record<string, number>;
  } {
    const totalWorkers = this.workers.size;
    const enabledWorkers = this.getEnabledWorkers().length;
    const lockedWorkers = Array.from(this.dispatchLocks.values()).filter(Boolean).length;
    
    const workersByType: Record<string, number> = {};
    for (const worker of this.workers.values()) {
      const type = worker.metadata.type;
      workersByType[type] = (workersByType[type] || 0) + 1;
    }

    return {
      totalWorkers,
      enabledWorkers,
      lockedWorkers,
      workersByType
    };
  }
}

// Create and export singleton instance
export const workerRegistry = new UnifiedWorkerRegistry();

// Legacy compatibility functions
export function registerWorker(name: string, handler: WorkerHandler, metadata?: Partial<WorkerMetadata>): boolean {
  return workerRegistry.registerWorker(name, handler, metadata);
}

export function getWorker(name: string): WorkerHandler | undefined {
  return workerRegistry.getWorkerHandler(name);
}

export function getWorkers(): string[] {
  return workerRegistry.getWorkerNames();
}

export function isValidWorker(name: string): boolean {
  return workerRegistry.validateWorker(name);
}
/**
 * Worker Manager - Auto-launch and manage OpenAI SDK workers
 * Handles worker lifecycle, monitoring, and auto-restart functionality
 */

import { fork, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WorkerProcess {
  id: string;
  process: ChildProcess | null;
  filePath: string;
  status: 'running' | 'stopped' | 'error' | 'starting';
  lastRun: Date;
  restartCount: number;
  logs: string[];
  startTime?: Date;
}

interface WorkerStatus {
  activeWorkers: string[];
  lastRunTimestamps: Record<string, string>;
  errors: Record<string, string>;
  uptime: Record<string, string>;
}

class WorkerManager {
  private workers: Map<string, WorkerProcess> = new Map();
  private workersDir: string;
  private maxRestarts = 3;
  private restartDelay = 5000; // 5 seconds

  constructor() {
    // Use /app/workers/ directory as specified in requirements, with fallback
    this.workersDir = '/app/workers';
    this.ensureWorkersDirectory();
  }

  private ensureWorkersDirectory(): void {
    if (!fs.existsSync(this.workersDir)) {
      try {
        fs.mkdirSync(this.workersDir, { recursive: true });
        this.logActivity(`Created workers directory: ${this.workersDir}`);
      } catch (error) {
        // Fallback to local workers directory if permission denied
        this.workersDir = './workers';
        this.logActivity(`Permission denied for /app/workers, using fallback: ${this.workersDir}`);
        
        if (!fs.existsSync(this.workersDir)) {
          try {
            fs.mkdirSync(this.workersDir, { recursive: true });
            this.logActivity(`Created fallback workers directory: ${this.workersDir}`);
          } catch (fallbackError) {
            this.logActivity(`Failed to create workers directory: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`);
          }
        }
      }
    }
  }

  private logActivity(message: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [WorkerManager] ${message}`;
    console.log(logEntry);

    // Log to session.log with enhanced error handling
    try {
      const logPath = process.env.NODE_ENV === 'production' ? '/var/arc/log/session.log' : './memory/session.log';
      const logDir = path.dirname(logPath);
      
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
        } catch (dirError) {
          // If we can't create the production log dir, use fallback
          if (logPath.includes('/var/arc')) {
            const fallbackPath = './memory/session.log';
            const fallbackDir = path.dirname(fallbackPath);
            if (!fs.existsSync(fallbackDir)) {
              fs.mkdirSync(fallbackDir, { recursive: true });
            }
            fs.appendFileSync(fallbackPath, logEntry + '\n');
            return;
          }
          throw dirError;
        }
      }
      fs.appendFileSync(logPath, logEntry + '\n');
    } catch (error) {
      console.error('Failed to write to session log:', error instanceof Error ? error.message : 'Unknown error');
      // Continue without crashing - logging failure shouldn't stop the worker manager
    }
  }

  /**
   * Scan /workers/ directory for all .js files using OpenAI SDK
   */
  scanWorkers(): string[] {
    const workerFiles: string[] = [];
    
    try {
      const files = fs.readdirSync(this.workersDir);
      
      for (const file of files) {
        // Skip shared directory and non-JS files
        if (file === 'shared' || !file.endsWith('.js')) {
          continue;
        }
        
        const filePath = path.join(this.workersDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          
          // Check if file uses OpenAI SDK (updated patterns for shared utilities)
          if ((content.includes('openai') || content.includes('createOpenAIClient')) && 
              (content.includes('chat.completions.create') || 
               content.includes('from \'openai\'') || 
               content.includes('import OpenAI') ||
               content.includes('executeWorker'))) {
            workerFiles.push(file);
            this.logActivity(`Found OpenAI SDK worker: ${file}`);
          }
        } catch (error) {
          this.logActivity(`Error reading worker file ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      this.logActivity(`Error scanning workers directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return workerFiles;
  }

  /**
   * Launch a worker using child_process.fork()
   */
  private launchWorker(workerFile: string): void {
    const workerId = path.basename(workerFile, '.js');
    const workerPath = path.join(this.workersDir, workerFile);

    if (this.workers.has(workerId) && this.workers.get(workerId)?.status === 'running') {
      this.logActivity(`Worker ${workerId} is already running`);
      return;
    }

    this.logActivity(`Launching worker: ${workerId}`);

    try {
      // Inject environment variables with validation
      const env = {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        AI_MODEL: process.env.AI_MODEL || 'gpt-3.5-turbo'
      };

      // Log warning for missing API key but continue
      if (!env.OPENAI_API_KEY) {
        this.logActivity(`Warning: Worker ${workerId} starting without OPENAI_API_KEY`);
      }

      const childProcess = fork(workerPath, [], {
        env,
        stdio: 'inherit',
        execArgv: ['--experimental-modules']
      });

      const workerProcess: WorkerProcess = {
        id: workerId,
        process: childProcess,
        filePath: workerPath,
        status: 'starting',
        lastRun: new Date(),
        restartCount: 0,
        logs: [],
        startTime: new Date()
      };

      this.workers.set(workerId, workerProcess);

      // Handle process events
      childProcess.on('message', (message) => {
        workerProcess.logs.push(`[${new Date().toISOString()}] ${message}`);
      });

      childProcess.on('error', (error) => {
        this.logActivity(`Worker ${workerId} error: ${error.message}`);
        workerProcess.status = 'error';
        workerProcess.logs.push(`[${new Date().toISOString()}] ERROR: ${error.message}`);
        this.handleWorkerFailure(workerId);
      });

      childProcess.on('exit', (code, signal) => {
        this.logActivity(`Worker ${workerId} exited with code ${code}, signal ${signal}`);
        workerProcess.status = code === 0 ? 'stopped' : 'error';
        
        if (code !== 0) {
          this.handleWorkerFailure(workerId);
        }
      });

      // Mark as running after successful start
      setTimeout(() => {
        if (childProcess.pid && !childProcess.killed) {
          workerProcess.status = 'running';
          this.logActivity(`✅ ${workerId} running with model: ${env.AI_MODEL}`);
        }
      }, 1000);

    } catch (error) {
      this.logActivity(`Failed to launch worker ${workerId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle worker failure and implement auto-restart
   */
  private handleWorkerFailure(workerId: string): void {
    const workerProcess = this.workers.get(workerId);
    if (!workerProcess) return;

    workerProcess.restartCount++;
    
    if (workerProcess.restartCount < this.maxRestarts) {
      this.logActivity(`Restarting worker ${workerId} (attempt ${workerProcess.restartCount}/${this.maxRestarts})`);
      
      setTimeout(() => {
        this.launchWorker(path.basename(workerProcess.filePath));
      }, this.restartDelay);
    } else {
      this.logActivity(`Worker ${workerId} failed too many times, giving up`);
      workerProcess.status = 'error';
    }
  }

  /**
   * Auto-launch all discovered workers
   */
  launchAllWorkers(): void {
    this.logActivity('Starting worker auto-launch sequence');
    
    const workerFiles = this.scanWorkers();
    
    if (workerFiles.length === 0) {
      this.logActivity('No OpenAI SDK workers found');
      return;
    }

    this.logActivity(`Found ${workerFiles.length} OpenAI SDK workers`);
    
    for (const workerFile of workerFiles) {
      this.launchWorker(workerFile);
    }
  }

  /**
   * Get worker status for the /workers/status endpoint
   */
  getWorkerStatus(): WorkerStatus {
    const activeWorkers: string[] = [];
    const lastRunTimestamps: Record<string, string> = {};
    const errors: Record<string, string> = {};
    const uptime: Record<string, string> = {};

    for (const [workerId, worker] of this.workers.entries()) {
      if (worker.status === 'running') {
        activeWorkers.push(workerId);
      }
      
      lastRunTimestamps[workerId] = worker.lastRun.toISOString();
      
      if (worker.status === 'error' && worker.logs.length > 0) {
        const errorLogs = worker.logs.filter(log => log.includes('ERROR'));
        errors[workerId] = errorLogs[errorLogs.length - 1] || 'Unknown error';
      }
      
      if (worker.startTime) {
        const uptimeMs = Date.now() - worker.startTime.getTime();
        uptime[workerId] = this.formatUptime(uptimeMs);
      }
    }

    return {
      activeWorkers,
      lastRunTimestamps,
      errors,
      uptime
    };
  }

  private formatUptime(uptimeMs: number): string {
    const seconds = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Stop all workers
   */
  stopAllWorkers(): void {
    this.logActivity('Stopping all workers');
    
    for (const [workerId, worker] of this.workers.entries()) {
      if (worker.process && worker.status === 'running') {
        this.logActivity(`Stopping worker: ${workerId}`);
        worker.process.kill('SIGTERM');
        worker.status = 'stopped';
      }
    }
  }

  /**
   * Restart a specific worker
   */
  restartWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logActivity(`Worker ${workerId} not found`);
      return false;
    }

    this.logActivity(`Restarting worker: ${workerId}`);
    
    if (worker.process && worker.status === 'running') {
      worker.process.kill('SIGTERM');
    }
    
    worker.restartCount = 0; // Reset restart count for manual restart
    setTimeout(() => {
      this.launchWorker(path.basename(worker.filePath));
    }, 1000);
    
    return true;
  }
}

export default WorkerManager;
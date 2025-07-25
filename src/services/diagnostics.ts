// ARCANOS AI-Controlled Diagnostics Service
// All diagnostic operations are routed through AI model for decision making

import * as os from 'os';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { getQueueAudit, getQueueStats } from './jobQueue';

const execAsync = promisify(exec);

export interface DiagnosticResult {
  success: boolean;
  command: string;
  category: string;
  data: any;
  timestamp: string;
  error?: string;
  forceMode?: boolean;
}

export interface DiagnosticRequest {
  command: string;
  force?: boolean;
}

// JSON-based diagnostic instruction templates for AI model
export const DIAGNOSTIC_INSTRUCTIONS = {
  memory: {
    action: 'execute',
    service: 'diagnostic',
    parameters: { type: 'memory' },
    execute: true,
    priority: 7
  },
  cpu: {
    action: 'execute',
    service: 'diagnostic',
    parameters: { type: 'cpu' },
    execute: true,
    priority: 7
  },
  disk: {
    action: 'execute',
    service: 'diagnostic',
    parameters: { type: 'disk' },
    execute: true,
    priority: 7
  },
  network: {
    action: 'execute',
    service: 'diagnostic',
    parameters: { type: 'network' },
    execute: true,
    priority: 6
  },
  system: {
    action: 'execute',
    service: 'diagnostic',
    parameters: { type: 'system' },
    execute: true,
    priority: 8
  },
  queue: {
    action: 'execute',
    service: 'diagnostic',
    parameters: { type: 'queue' },
    execute: true,
    priority: 9
  },
  endpoint: {
    action: 'execute',
    service: 'diagnostic',
    parameters: { type: 'endpoint', url: '' },
    execute: true,
    priority: 5
  }
};

export class DiagnosticsService {
  
  /**
   * AI-controlled diagnostic execution - minimal hardcoded logic
   */
  async executeDiagnosticCommand(command: string): Promise<DiagnosticResult> {
    const timestamp = new Date().toISOString();

    try {
      // Convert command to diagnostic instruction for AI model
      const instruction = this.createDiagnosticInstruction(command);
      
      // Execute based on AI instruction parameters
      const data = await this.executeDiagnosticInstruction(instruction);
      
      return {
        success: true,
        command,
        category: instruction.parameters.type,
        data,
        timestamp
      };

    } catch (error: any) {
      return {
        success: false,
        command,
        category: 'error',
        data: {},
        timestamp,
        error: error.message
      };
    }
  }

  /**
   * Execute forced diagnostics - bypasses inference and directly executes all diagnostic tasks
   */
  async executeForcedDiagnostics(command: string = 'forced diagnostic'): Promise<DiagnosticResult> {
    const timestamp = new Date().toISOString();

    try {
      console.log('🔧 FORCE-MODE: Executing all diagnostic tasks directly, bypassing inference');
      
      // Execute all diagnostic types including queue audits
      const diagnosticTasks = [
        this.getSystemDiagnostics(),
        this.getMemoryDiagnostics(),
        this.getCpuDiagnostics(),
        this.getDiskDiagnostics(),
        this.getNetworkDiagnostics(),
        this.getQueueAudit()
      ];

      const results = await Promise.allSettled(diagnosticTasks);
      
      // Categorize results
      const categorizedResults = {
        completed: [] as any[],
        pending: [] as any[],
        'in-progress': [] as any[],
        failed: [] as any[]
      };

      // Process all results
      results.forEach((result, index) => {
        const taskNames = ['system', 'memory', 'cpu', 'disk', 'network', 'queue'];
        const taskName = taskNames[index];
        
        if (result.status === 'fulfilled') {
          const taskResult = result.value;
          
          // Special handling for queue audit results
          if (taskName === 'queue' && taskResult && typeof taskResult === 'object') {
            // Check if this is a queue audit result with the expected structure
            if ('pending' in taskResult && Array.isArray(taskResult.pending)) {
              categorizedResults.pending.push(...taskResult.pending);
            }
            if ('inProgress' in taskResult && Array.isArray(taskResult.inProgress)) {
              categorizedResults['in-progress'].push(...taskResult.inProgress);
            }
            if ('completed' in taskResult && Array.isArray(taskResult.completed)) {
              categorizedResults.completed.push(...taskResult.completed);
            }
            if ('failed' in taskResult && Array.isArray(taskResult.failed)) {
              categorizedResults.failed.push(...taskResult.failed);
            }
          } else {
            categorizedResults.completed.push({
              task: taskName,
              status: 'completed',
              category: 'completed',
              data: taskResult,
              timestamp
            });
          }
        } else {
          categorizedResults.failed.push({
            task: taskName,
            status: 'failed',
            category: 'failed',
            error: result.reason?.message || 'Unknown error',
            timestamp
          });
        }
      });

      console.log(`✅ FORCE-MODE: Completed forced diagnostics. Results - Completed: ${categorizedResults.completed.length}, Pending: ${categorizedResults.pending.length}, In-Progress: ${categorizedResults['in-progress'].length}, Failed: ${categorizedResults.failed.length}`);

      return {
        success: true,
        command,
        category: 'forced',
        data: categorizedResults,
        timestamp,
        forceMode: true
      };

    } catch (error: any) {
      console.error('❌ FORCE-MODE: Error executing forced diagnostics:', error);
      return {
        success: false,
        command,
        category: 'error',
        data: {},
        timestamp,
        error: error.message,
        forceMode: true
      };
    }
  }

  /**
   * Create AI-compatible diagnostic instruction from natural language
   */
  private createDiagnosticInstruction(command: string): any {
    const normalizedCommand = command.toLowerCase().trim();
    
    // Simple keyword mapping to AI instructions
    if (this.containsKeywords(normalizedCommand, ['memory', 'ram', 'heap'])) {
      return DIAGNOSTIC_INSTRUCTIONS.memory;
    }
    if (this.containsKeywords(normalizedCommand, ['cpu', 'processor', 'performance', 'load'])) {
      return DIAGNOSTIC_INSTRUCTIONS.cpu;
    }
    if (this.containsKeywords(normalizedCommand, ['disk', 'storage', 'space', 'filesystem'])) {
      return DIAGNOSTIC_INSTRUCTIONS.disk;
    }
    if (this.containsKeywords(normalizedCommand, ['network', 'connectivity', 'ping', 'internet'])) {
      return DIAGNOSTIC_INSTRUCTIONS.network;
    }
    if (this.containsKeywords(normalizedCommand, ['queue', 'job', 'audit', 'pending', 'completed', 'failed'])) {
      return DIAGNOSTIC_INSTRUCTIONS.queue;
    }
    if (this.containsKeywords(normalizedCommand, ['endpoint', 'api', 'route', 'url'])) {
      const urlMatch = command.match(/https?:\/\/\S+|\/[\w\-\/]+/);
      const instruction = { ...DIAGNOSTIC_INSTRUCTIONS.endpoint };
      if (urlMatch) {
        instruction.parameters.url = urlMatch[0];
      }
      return instruction;
    }

    // Default to system diagnostic
    return DIAGNOSTIC_INSTRUCTIONS.system;
  }

  /**
   * Execute diagnostic instruction (called by AI execution engine)
   */
  async executeDiagnosticInstruction(instruction: any): Promise<any> {
    const { type } = instruction.parameters;

    switch (type) {
      case 'memory':
        return await this.getMemoryDiagnostics();
      case 'cpu':
        return await this.getCpuDiagnostics();
      case 'disk':
        return await this.getDiskDiagnostics();
      case 'network':
        return await this.getNetworkDiagnostics();
      case 'queue':
        return await this.getQueueAudit();
      case 'endpoint':
        return await this.scanApiEndpoint(instruction.parameters.url);
      case 'system':
      default:
        return await this.getSystemDiagnostics();
    }
  }

  /**
   * Check if command contains specific keywords
   */
  private containsKeywords(command: string, keywords: string[]): boolean {
    return keywords.some(keyword => command.includes(keyword));
  }

  /**
   * Get memory diagnostics
   */
  private async getMemoryDiagnostics() {
    const memoryUsage = process.memoryUsage();
    const systemMemory = {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem()
    };

    return {
      process: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers
      },
      system: {
        totalMemory: systemMemory.total,
        freeMemory: systemMemory.free,
        usedMemory: systemMemory.used,
        usagePercentage: ((systemMemory.used / systemMemory.total) * 100).toFixed(2)
      },
      formatted: {
        processRSS: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        processHeap: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        systemTotal: `${(systemMemory.total / 1024 / 1024 / 1024).toFixed(2)} GB`,
        systemFree: `${(systemMemory.free / 1024 / 1024 / 1024).toFixed(2)} GB`,
        systemUsed: `${(systemMemory.used / 1024 / 1024 / 1024).toFixed(2)} GB`
      }
    };
  }

  /**
   * Get CPU diagnostics
   */
  private async getCpuDiagnostics() {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    const uptime = os.uptime();
    const processUptime = process.uptime();

    return {
      cores: cpus.length,
      model: cpus[0]?.model || 'Unknown',
      speed: cpus[0]?.speed || 0,
      loadAverage: {
        '1min': loadAvg[0],
        '5min': loadAvg[1],
        '15min': loadAvg[2]
      },
      uptime: {
        system: uptime,
        process: processUptime
      },
      formatted: {
        cores: `${cpus.length} cores`,
        model: cpus[0]?.model || 'Unknown CPU',
        speed: `${(cpus[0]?.speed || 0) / 1000} GHz`,
        loadAvg1min: loadAvg[0].toFixed(2),
        systemUptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        processUptime: `${Math.floor(processUptime / 3600)}h ${Math.floor((processUptime % 3600) / 60)}m`
      }
    };
  }

  /**
   * Get disk diagnostics
   */
  private async getDiskDiagnostics() {
    try {
      const { stdout } = await execAsync('df -h / 2>/dev/null || echo "Disk info unavailable"');
      
      const lines = stdout.trim().split('\n');
      let diskInfo = null;
      if (lines.length > 1 && !stdout.includes('unavailable')) {
        const parts = lines[1].split(/\s+/);
        if (parts.length >= 4) {
          diskInfo = {
            filesystem: parts[0],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            usePercentage: parts[4],
            mountpoint: parts[5] || '/'
          };
        }
      }

      return {
        command: 'df -h /',
        disk: diskInfo,
        timestamp: new Date().toISOString()
      };

    } catch (error: any) {
      return {
        error: 'Unable to retrieve disk information',
        details: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get network diagnostics
   */
  private async getNetworkDiagnostics() {
    try {
      const networkInterfaces = os.networkInterfaces();
      
      return {
        interfaces: networkInterfaces,
        hostname: os.hostname(),
        timestamp: new Date().toISOString()
      };

    } catch (error: any) {
      return {
        error: 'Unable to retrieve network information',
        details: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get system diagnostics
   */
  private async getSystemDiagnostics() {
    const memory = await this.getMemoryDiagnostics();
    const cpu = await this.getCpuDiagnostics();
    
    return {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      nodeVersion: process.version,
      memory: memory.formatted,
      cpu: cpu.formatted,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get queue audit diagnostics
   */
  private async getQueueAudit() {
    try {
      const audit = getQueueAudit();
      const stats = getQueueStats();
      
      return {
        ...audit,
        stats,
        timestamp: new Date().toISOString(),
        auditType: 'queue'
      };
    } catch (error: any) {
      return {
        error: 'Unable to retrieve queue audit information',
        details: error.message,
        timestamp: new Date().toISOString(),
        auditType: 'queue'
      };
    }
  }

  /**
   * Scan an API endpoint with retry and timeout safeguards
   */
  private async scanApiEndpoint(url: string, maxRetries = 3, timeoutMs = 10000) {
    if (!url) {
      return { error: 'No endpoint URL provided', timestamp: new Date().toISOString() };
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get(url, { timeout: timeoutMs });
        return {
          url,
          status: response.status,
          data: response.data,
          attempt,
          timestamp: new Date().toISOString()
        };
      } catch (error: any) {
        console.warn(`⚠️ Diagnostic scan attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
        if (attempt === maxRetries) {
          console.error(`🚨 Diagnostic escalation: endpoint ${url} unreachable after ${maxRetries} attempts`);
          return {
            error: `Endpoint unreachable after ${maxRetries} attempts`,
            url,
            timestamp: new Date().toISOString()
          };
        }
        await new Promise(res => setTimeout(res, 1000));
      }
    }
  }
}

// Export singleton instance
export const diagnosticsService = new DiagnosticsService();

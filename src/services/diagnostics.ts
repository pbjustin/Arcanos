// ARCANOS AI-Controlled Diagnostics Service
// All diagnostic operations are routed through AI model for decision making

import * as os from 'os';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DiagnosticResult {
  success: boolean;
  command: string;
  category: string;
  data: any;
  timestamp: string;
  error?: string;
}

export interface DiagnosticRequest {
  command: string;
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
}

// Export singleton instance
export const diagnosticsService = new DiagnosticsService();
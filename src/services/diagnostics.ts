// ARCANOS GPT Diagnostics Prompt Language Service
// Interprets natural language commands for system diagnostics

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

export class DiagnosticsService {
  
  /**
   * Parse natural language diagnostic command and execute appropriate diagnostic
   */
  async executeDiagnosticCommand(command: string): Promise<DiagnosticResult> {
    const normalizedCommand = command.toLowerCase().trim();
    const timestamp = new Date().toISOString();

    try {
      // Memory Diagnostics
      if (this.isMemoryCommand(normalizedCommand)) {
        const data = await this.getMemoryDiagnostics();
        return {
          success: true,
          command,
          category: 'memory',
          data,
          timestamp
        };
      }

      // CPU Performance
      if (this.isCpuCommand(normalizedCommand)) {
        const data = await this.getCpuDiagnostics();
        return {
          success: true,
          command,
          category: 'cpu',
          data,
          timestamp
        };
      }

      // Disk & Storage
      if (this.isDiskCommand(normalizedCommand)) {
        const data = await this.getDiskDiagnostics();
        return {
          success: true,
          command,
          category: 'disk',
          data,
          timestamp
        };
      }

      // Network & I/O
      if (this.isNetworkCommand(normalizedCommand)) {
        const data = await this.getNetworkDiagnostics();
        return {
          success: true,
          command,
          category: 'network',
          data,
          timestamp
        };
      }

      // System Status
      if (this.isSystemCommand(normalizedCommand)) {
        const data = await this.getSystemDiagnostics();
        return {
          success: true,
          command,
          category: 'system',
          data,
          timestamp
        };
      }

      // Command not recognized
      return {
        success: false,
        command,
        category: 'unknown',
        data: { availableCategories: ['memory', 'cpu', 'disk', 'network', 'system'] },
        timestamp,
        error: 'Command not recognized. Available categories: memory, cpu, disk, network, system'
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
   * Check if command is memory-related
   */
  private isMemoryCommand(command: string): boolean {
    const memoryKeywords = [
      'memory', 'ram', 'check available memory', 'show ram usage',
      'run memory diagnostics', 'memory usage', 'free vs used',
      'memory in gigabytes', 'heap', 'memory status'
    ];
    return memoryKeywords.some(keyword => command.includes(keyword));
  }

  /**
   * Check if command is CPU-related
   */
  private isCpuCommand(command: string): boolean {
    const cpuKeywords = [
      'cpu', 'processor', 'performance check', 'how busy',
      'core usage', 'load average', 'real-time cpu',
      'cpu diagnostics', 'processing power'
    ];
    return cpuKeywords.some(keyword => command.includes(keyword));
  }

  /**
   * Check if command is disk-related
   */
  private isDiskCommand(command: string): boolean {
    const diskKeywords = [
      'disk', 'storage', 'disk usage', 'available disk space',
      'how much storage', 'largest directories', 'largest files',
      'disk space', 'storage usage'
    ];
    return diskKeywords.some(keyword => command.includes(keyword));
  }

  /**
   * Check if command is network-related
   */
  private isNetworkCommand(command: string): boolean {
    const networkKeywords = [
      'network', 'bandwidth', 'speed test', 'network connections',
      'active connections', 'open ports', 'listeners',
      'network usage', 'internet speed'
    ];
    return networkKeywords.some(keyword => command.includes(keyword));
  }

  /**
   * Check if command is system-related
   */
  private isSystemCommand(command: string): boolean {
    const systemKeywords = [
      'system', 'health check', 'active processes', 'uptime',
      'resource summary', 'diagnostic sweep', 'full system',
      'system status', 'all processes'
    ];
    return systemKeywords.some(keyword => command.includes(keyword));
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

    // Try to get V8 heap statistics
    let v8Stats = null;
    try {
      v8Stats = require('v8').getHeapStatistics();
    } catch (error) {
      // V8 not available
    }

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
      },
      v8: v8Stats ? {
        heapSizeLimit: v8Stats.heap_size_limit,
        totalHeapSize: v8Stats.total_heap_size,
        usedHeapSize: v8Stats.used_heap_size,
        mallocedMemory: v8Stats.malloced_memory,
        peakMallocedMemory: v8Stats.peak_malloced_memory
      } : null
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

    // Get CPU usage over a short interval
    const startTime = process.hrtime();
    const startUsage = process.cpuUsage();
    
    // Wait 100ms to measure CPU usage
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const endTime = process.hrtime(startTime);
    const endUsage = process.cpuUsage(startUsage);
    
    // Calculate CPU usage percentage
    const totalTime = endTime[0] * 1000000 + endTime[1] / 1000; // Convert to microseconds
    const userPercent = (endUsage.user / totalTime) * 100;
    const systemPercent = (endUsage.system / totalTime) * 100;

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
      usage: {
        user: userPercent.toFixed(2),
        system: systemPercent.toFixed(2),
        total: (userPercent + systemPercent).toFixed(2)
      },
      formatted: {
        cores: `${cpus.length} cores`,
        model: cpus[0]?.model || 'Unknown CPU',
        speed: `${(cpus[0]?.speed || 0) / 1000} GHz`,
        loadAvg1min: loadAvg[0].toFixed(2),
        loadAvg5min: loadAvg[1].toFixed(2),
        loadAvg15min: loadAvg[2].toFixed(2),
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
      // Get disk usage using df command (Unix/Linux/macOS)
      const { stdout } = await execAsync('df -h / 2>/dev/null || echo "Disk info unavailable"');
      
      // Parse df output
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

      // Get largest directories (top 10)
      let largestDirs = null;
      try {
        const { stdout: duOutput } = await execAsync('du -sh /* 2>/dev/null | sort -hr | head -10 || echo "Directory info unavailable"');
        if (!duOutput.includes('unavailable')) {
          largestDirs = duOutput.trim().split('\n').map(line => {
            const parts = line.split('\t');
            return { size: parts[0], path: parts[1] };
          });
        }
      } catch (error) {
        // Directory scan failed, continue without it
      }

      return {
        disk: diskInfo,
        largestDirectories: largestDirs,
        rawOutput: stdout.trim(),
        formatted: diskInfo ? {
          totalSpace: diskInfo.size,
          usedSpace: diskInfo.used,
          availableSpace: diskInfo.available,
          usagePercentage: diskInfo.usePercentage,
          filesystem: diskInfo.filesystem
        } : { error: 'Disk information unavailable on this system' }
      };
    } catch (error: any) {
      return {
        error: error.message,
        formatted: { error: 'Unable to retrieve disk information' }
      };
    }
  }

  /**
   * Get network diagnostics
   */
  private async getNetworkDiagnostics() {
    const networkInterfaces = os.networkInterfaces();
    
    // Get active network connections
    let connections = null;
    try {
      const { stdout } = await execAsync('ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null || echo "Network info unavailable"');
      if (!stdout.includes('unavailable')) {
        const lines = stdout.trim().split('\n');
        connections = lines.slice(1).map(line => {
          const parts = line.split(/\s+/);
          return {
            protocol: parts[0],
            localAddress: parts[3] || parts[4],
            state: parts[1] || 'UNKNOWN'
          };
        }).slice(0, 20); // Limit to first 20 connections
      }
    } catch (error) {
      // Network command failed
    }

    // Process network interfaces
    const interfaces: any = {};
    Object.keys(networkInterfaces).forEach(name => {
      const nets = networkInterfaces[name];
      if (nets) {
        interfaces[name] = nets.map(net => ({
          address: net.address,
          family: net.family,
          internal: net.internal,
          mac: net.mac
        }));
      }
    });

    return {
      interfaces,
      activeConnections: connections,
      interfaceCount: Object.keys(interfaces).length,
      formatted: {
        interfaces: Object.keys(interfaces).join(', '),
        activeConnectionCount: connections ? connections.length : 'Unknown',
        publicInterfaces: Object.keys(interfaces).filter(name => 
          interfaces[name].some((net: any) => !net.internal)
        ).join(', ') || 'None detected'
      }
    };
  }

  /**
   * Get system diagnostics (comprehensive health check)
   */
  private async getSystemDiagnostics() {
    const memData = await this.getMemoryDiagnostics();
    const cpuData = await this.getCpuDiagnostics();
    const diskData = await this.getDiskDiagnostics();
    const networkData = await this.getNetworkDiagnostics();

    // Get active processes count
    let processCount = null;
    try {
      const { stdout } = await execAsync('ps aux 2>/dev/null | wc -l || echo "0"');
      processCount = parseInt(stdout.trim()) - 1; // Subtract header line
    } catch (error) {
      // Process count failed
    }

    // System information
    const systemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      nodeVersion: process.version,
      processId: process.pid
    };

    return {
      system: systemInfo,
      memory: memData,
      cpu: cpuData,
      disk: diskData,
      network: networkData,
      processes: {
        count: processCount,
        nodeProcess: {
          pid: process.pid,
          uptime: process.uptime(),
          version: process.version
        }
      },
      healthStatus: this.calculateHealthStatus(memData, cpuData, diskData),
      formatted: {
        platform: `${systemInfo.platform} ${systemInfo.arch}`,
        uptime: `${Math.floor(systemInfo.uptime / 86400)}d ${Math.floor((systemInfo.uptime % 86400) / 3600)}h`,
        hostname: systemInfo.hostname,
        nodeVersion: systemInfo.nodeVersion,
        processCount: processCount ? `${processCount} processes` : 'Unknown'
      }
    };
  }

  /**
   * Calculate overall health status
   */
  private calculateHealthStatus(memData: any, cpuData: any, diskData: any): string {
    const memUsage = parseFloat(memData.system.usagePercentage);
    const cpuLoad = cpuData.loadAverage['1min'];
    const cpuCores = cpuData.cores;
    
    // Health indicators
    const memoryHealthy = memUsage < 80; // Less than 80% memory usage
    const cpuHealthy = cpuLoad < cpuCores * 0.8; // Load average less than 80% of cores
    const diskHealthy = !diskData.disk || !diskData.disk.usePercentage || 
                       parseFloat(diskData.disk.usePercentage.replace('%', '')) < 90;

    if (memoryHealthy && cpuHealthy && diskHealthy) {
      return 'HEALTHY';
    } else if (!memoryHealthy || !cpuHealthy || !diskHealthy) {
      return 'WARNING';
    } else {
      return 'CRITICAL';
    }
  }
}

export const diagnosticsService = new DiagnosticsService();
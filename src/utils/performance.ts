// Performance Monitoring Utilities for ARCANOS Backend
interface PerformanceMetrics {
  memory: {
    rss: string;
    heapUsed: string;
    heapTotal: string;
    external: string;
  };
  cpu: {
    uptime: string;
    loadAverage?: number[];
  };
  timing: {
    startup: number;
    lastMemorySnapshot: number;
    lastRequest: number;
  };
  requests: {
    total: number;
    successful: number;
    errors: number;
    averageResponseTime: number;
  };
}

class PerformanceMonitor {
  private startupTime: number;
  private requestCount = 0;
  private successfulRequests = 0;
  private errorRequests = 0;
  private responseTimes: number[] = [];
  private lastMemorySnapshot = 0;
  private lastRequestTime = 0;
  private readonly maxResponseTimeHistory = 100; // Keep last 100 response times

  constructor() {
    this.startupTime = Date.now();
  }

  // Track request performance
  trackRequest(responseTime: number, isError = false) {
    this.requestCount++;
    this.lastRequestTime = Date.now();
    
    if (isError) {
      this.errorRequests++;
    } else {
      this.successfulRequests++;
    }

    // Add response time to history
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > this.maxResponseTimeHistory) {
      this.responseTimes.shift();
    }
  }

  // Update memory snapshot timestamp
  updateMemorySnapshot() {
    this.lastMemorySnapshot = Date.now();
  }

  // Get current performance metrics
  getMetrics(): PerformanceMetrics {
    const memory = process.memoryUsage();
    const uptime = process.uptime();
    
    // Calculate average response time
    const avgResponseTime = this.responseTimes.length > 0 
      ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length 
      : 0;

    return {
      memory: {
        rss: this.formatBytes(memory.rss),
        heapUsed: this.formatBytes(memory.heapUsed),
        heapTotal: this.formatBytes(memory.heapTotal),
        external: this.formatBytes(memory.external),
      },
      cpu: {
        uptime: this.formatDuration(uptime * 1000),
        loadAverage: process.platform !== 'win32' ? require('os').loadavg() : undefined,
      },
      timing: {
        startup: this.startupTime,
        lastMemorySnapshot: this.lastMemorySnapshot,
        lastRequest: this.lastRequestTime,
      },
      requests: {
        total: this.requestCount,
        successful: this.successfulRequests,
        errors: this.errorRequests,
        averageResponseTime: Math.round(avgResponseTime),
      },
    };
  }

  // Format bytes to human readable
  private formatBytes(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  // Format duration to human readable
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // Get memory pressure warning
  getMemoryPressureStatus(): { status: 'ok' | 'warning' | 'critical'; message: string } {
    const memory = process.memoryUsage();
    const heapUsedMB = memory.heapUsed / 1024 / 1024;
    const rssMB = memory.rss / 1024 / 1024;

    if (rssMB > 6000) { // Over 6GB
      return { status: 'critical', message: `RSS memory usage is critical: ${this.formatBytes(memory.rss)}` };
    }
    if (rssMB > 4000) { // Over 4GB
      return { status: 'warning', message: `RSS memory usage is high: ${this.formatBytes(memory.rss)}` };
    }
    if (heapUsedMB > 3000) { // Over 3GB heap
      return { status: 'warning', message: `Heap usage is high: ${this.formatBytes(memory.heapUsed)}` };
    }

    return { status: 'ok', message: 'Memory usage is normal' };
  }

  // Performance summary for logs
  getPerformanceSummary(): string {
    const metrics = this.getMetrics();
    const memoryStatus = this.getMemoryPressureStatus();
    
    return [
      `Memory: ${metrics.memory.rss} RSS, ${metrics.memory.heapUsed} heap`,
      `Uptime: ${metrics.cpu.uptime}`,
      `Requests: ${metrics.requests.total} total, ${metrics.requests.errors} errors`,
      `Avg Response: ${metrics.requests.averageResponseTime}ms`,
      `Status: ${memoryStatus.status.toUpperCase()}`
    ].join(' | ');
  }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor();

// Express middleware for tracking request performance
export function performanceMiddleware(req: any, res: any, next: any) {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    const isError = res.statusCode >= 400;
    performanceMonitor.trackRequest(responseTime, isError);
  });
  
  next();
}
// ARCANOS:ROUTE-RECOVERY - Route recovery logic for missing controllers or invalid schemas
// Handles route failures and provides recovery mechanisms

import { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { memoryHandler } from './memory-handler.js';
import { writeHandler } from './write-handler.js';
import { auditHandler } from './audit-handler.js';
import { diagnosticHandler } from './diagnostic-handler.js';
import { createServiceLogger } from '../utils/logger.js';

const logger = createServiceLogger('RouteRecovery');

export interface RouteRecoveryConfig {
  route: string;
  handler: string;
  recovery_attempts: number;
  last_recovery?: string;
  status: 'active' | 'recovering' | 'failed';
}

export class RouteRecovery {
  private recoveryLog: any[] = [];
  private routeStatuses: Map<string, RouteRecoveryConfig> = new Map();
  private app: Express | null = null;

  constructor() {
    this.initializeRouteStatuses();
  }

  setApp(app: Express): void {
    this.app = app;
    this.setupRouteRecoveryMiddleware();
  }

  private initializeRouteStatuses(): void {
    const routes = [
      { route: '/memory', handler: 'memory-handler' },
      { route: '/write', handler: 'write-handler' },
      { route: '/audit', handler: 'audit-handler' },
      { route: '/diagnostic', handler: 'diagnostic-handler' }
    ];

    routes.forEach(({ route, handler }) => {
      this.routeStatuses.set(route, {
        route,
        handler,
        recovery_attempts: 0,
        status: 'active'
      });
    });

    console.log('🔄 ROUTE-RECOVERY: Initialized route statuses for recovery tracking');
  }

  private setupRouteRecoveryMiddleware(): void {
    if (!this.app) return;

    // Global error handler for route recovery
    this.app.use(this.routeRecoveryMiddleware.bind(this));
    console.log('🛡️ ROUTE-RECOVERY: Recovery middleware installed');
  }

  private routeRecoveryMiddleware(error: any, req: Request, res: Response, next: NextFunction): void {
    const route = req.path;
    const timestamp = new Date().toISOString();

    console.log('🚨 ROUTE-RECOVERY: Route failure detected:', { route, error: error.message, timestamp });

    // Check if this is a route we can recover
    if (this.routeStatuses.has(route)) {
      this.handleRouteFailure(route, error, req, res);
    } else {
      // Pass through to default error handler
      next(error);
    }
  }

  private async handleRouteFailure(route: string, error: any, req: Request, res: Response): Promise<void> {
    const routeConfig = this.routeStatuses.get(route)!;
    const timestamp = new Date().toISOString();

    // Log the failure
    this.logRecoveryActivity('route_failure', {
      route,
      handler: routeConfig.handler,
      error: error.message,
      recovery_attempts: routeConfig.recovery_attempts,
      timestamp
    });

    // Update route status
    routeConfig.status = 'recovering';
    routeConfig.recovery_attempts += 1;
    routeConfig.last_recovery = timestamp;

    logger.info('🔄 Attempting recovery for route:', { 
      route, 
      attempt: routeConfig.recovery_attempts 
    });

    try {
      // First attempt: Route-specific recovery
      let recoveryResult = await this.attemptRouteRecovery(route, req, res);
      
      // If that fails, try bootstrap recovery
      if (!recoveryResult.success && routeConfig.recovery_attempts === 1) {
        logger.info(`🔧 Attempting bootstrap recovery for route: ${route}`);
        const bootstrapResult = await this.bootstrapFailedRoute(route);
        
        if (bootstrapResult.success) {
          // Retry route recovery after bootstrap
          recoveryResult = await this.attemptRouteRecovery(route, req, res);
        }
      }
      
      if (recoveryResult.success) {
        routeConfig.status = 'active';
        logger.success('✅ Route recovered successfully:', route);
        
        this.logRecoveryActivity('route_recovered', {
          route,
          handler: routeConfig.handler,
          recovery_attempts: routeConfig.recovery_attempts,
          timestamp: new Date().toISOString()
        });
      } else {
        throw new Error(recoveryResult.message);
      }
    } catch (recoveryError: any) {
      logger.error('❌ Recovery failed for route:', route, recoveryError.message);
      
      routeConfig.status = 'failed';
      
      this.logRecoveryActivity('route_recovery_failed', {
        route,
        handler: routeConfig.handler,
        recovery_attempts: routeConfig.recovery_attempts,
        error: recoveryError.message,
        timestamp: new Date().toISOString()
      });

      // Send fallback response
      await this.sendFallbackResponse(route, req, res);
    }
  }

  private async attemptRouteRecovery(route: string, req: Request, res: Response): Promise<{ success: boolean; message: string }> {
    try {
      switch (route) {
        case '/memory':
          // Test memory handler functionality
          if (req.method === 'POST') {
            await memoryHandler.handleMemoryRequest(req, res);
            return { success: true, message: 'Memory route recovered' };
          }
          break;

        case '/write':
          // Test write handler functionality
          if (req.method === 'POST') {
            await writeHandler.handleWriteRequest(req, res);
            return { success: true, message: 'Write route recovered' };
          }
          break;

        case '/audit':
          // Test audit handler functionality
          if (req.method === 'POST') {
            await auditHandler.handleAuditRequest(req, res);
            return { success: true, message: 'Audit route recovered' };
          }
          break;

        case '/diagnostic':
          // Test diagnostic handler functionality and use its recovery method
          const diagnosticRecovery = await diagnosticHandler.recoverRoute();
          if (diagnosticRecovery.success && req.method === 'GET') {
            await diagnosticHandler.handleDiagnosticRequest(req, res);
            return { success: true, message: 'Diagnostic route recovered' };
          }
          return diagnosticRecovery;

        default:
          return { success: false, message: 'Unknown route for recovery' };
      }

      return { success: false, message: 'Recovery method not applicable for request type' };
    } catch (error: any) {
      return { success: false, message: `Recovery attempt failed: ${error.message}` };
    }
  }

  private async sendFallbackResponse(route: string, req: Request, res: Response): Promise<void> {
    try {
      let fallbackType: 'memory' | 'write' | 'audit' | 'diagnostic' | 'general' = 'general';
      
      if (route === '/memory') fallbackType = 'memory';
      else if (route === '/write') fallbackType = 'write';
      else if (route === '/audit') fallbackType = 'audit';
      else if (route === '/diagnostic') fallbackType = 'diagnostic';

      // Streamlined error response - no fallback logic
      res.status(503).json({
        error: 'Route temporarily unavailable',
        route,
        recovery_status: 'failed',
        message: 'Service degraded - route not available',
        timestamp: new Date().toISOString()
      });

    } catch (fallbackError: any) {
      console.error('❌ FALLBACK-RESPONSE: Even fallback failed:', fallbackError);
      res.status(503).json({
        error: 'Service completely unavailable',
        route,
        message: 'All recovery attempts failed',
        timestamp: new Date().toISOString()
      });
    }
  }

  private logRecoveryActivity(activity: string, details: any): void {
    const logEntry = {
      activity,
      details,
      logged_at: new Date().toISOString()
    };

    this.recoveryLog.push(logEntry);
    
    // Keep only last 50 entries to prevent memory issues
    if (this.recoveryLog.length > 50) {
      this.recoveryLog.shift();
    }

    console.log('📝 RECOVERY-LOG: Activity logged:', {
      activity,
      route: details.route,
      timestamp: logEntry.logged_at
    });
  }

  // Method to get current route statuses
  getRouteStatuses(): RouteRecoveryConfig[] {
    return Array.from(this.routeStatuses.values());
  }

  // Method to get recovery logs
  getRecoveryLogs(): any[] {
    return [...this.recoveryLog];
  }

  // Method to manually reset a route status
  resetRouteStatus(route: string): boolean {
    if (this.routeStatuses.has(route)) {
      const config = this.routeStatuses.get(route)!;
      config.status = 'active';
      config.recovery_attempts = 0;
      config.last_recovery = undefined;
      
      this.logRecoveryActivity('route_reset', {
        route,
        timestamp: new Date().toISOString()
      });
      
      console.log('🔄 ROUTE-RECOVERY: Route status reset:', route);
      return true;
    }
    return false;
  }

  // Method to validate route schemas with enhanced zod validation
  validateRouteSchema(route: string, data: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
      switch (route) {
        case '/memory':
          const memorySchema = z.object({
            memory_key: z.string().min(1, 'memory_key is required'),
            memory_value: z.any(),
            operation: z.enum(['store', 'load', 'list', 'clear']).optional()
          });
          memorySchema.parse(data);
          break;

        case '/write':
          const writeSchema = z.object({
            message: z.string().min(1, 'message is required'),
            type: z.enum(['creative', 'technical', 'documentation']).optional(),
            context: z.record(z.any()).optional()
          });
          writeSchema.parse(data);
          break;

        case '/audit':
          const auditSchema = z.object({
            message: z.string().min(1, 'message is required for audit'),
            target: z.string().optional(),
            auditType: z.enum(['code', 'security', 'performance']).optional()
          });
          auditSchema.parse(data);
          break;

        case '/diagnostic':
          const diagnosticSchema = z.object({
            command: z.string().optional(),
            type: z.enum(['health', 'performance', 'memory']).optional()
          });
          diagnosticSchema.parse(data);
          break;

        default:
          errors.push('Unknown route for schema validation');
      }
    } catch (zodError: any) {
      if (zodError instanceof z.ZodError) {
        errors.push(...zodError.errors.map(e => `${e.path.join('.')}: ${e.message}`));
      } else {
        errors.push(`Validation error: ${zodError.message}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // Enhanced route bootstrap logic for initialization failures
  async bootstrapFailedRoute(route: string): Promise<{ success: boolean; message: string }> {
    logger.info(`🔧 Attempting bootstrap recovery for route: ${route}`);
    
    try {
      switch (route) {
        case '/memory':
          // Bootstrap memory handler
          const { memoryHandler } = await import('./memory-handler.js');
          // Check if initialize method exists, otherwise skip
          if (typeof (memoryHandler as any).initialize === 'function') {
            await (memoryHandler as any).initialize();
          }
          return { success: true, message: 'Memory handler bootstrapped' };

        case '/write':
          // Bootstrap write handler
          const { writeHandler } = await import('./write-handler.js');
          // Check if initialize method exists, otherwise skip
          if (typeof (writeHandler as any).initialize === 'function') {
            await (writeHandler as any).initialize();
          }
          return { success: true, message: 'Write handler bootstrapped' };

        case '/audit':
          // Bootstrap audit handler
          const { auditHandler } = await import('./audit-handler.js');
          // Check if initialize method exists, otherwise skip
          if (typeof (auditHandler as any).initialize === 'function') {
            await (auditHandler as any).initialize();
          }
          return { success: true, message: 'Audit handler bootstrapped' };

        case '/diagnostic':
          // Bootstrap diagnostic handler with enhanced recovery
          const { diagnosticHandler } = await import('./diagnostic-handler.js');
          // Check if performFullBootstrap method exists, otherwise use basic recovery
          if (typeof (diagnosticHandler as any).performFullBootstrap === 'function') {
            const diagnosticResult = await (diagnosticHandler as any).performFullBootstrap();
            return diagnosticResult || { success: true, message: 'Diagnostic handler bootstrapped' };
          } else if (typeof (diagnosticHandler as any).recoverRoute === 'function') {
            return await (diagnosticHandler as any).recoverRoute();
          }
          return { success: true, message: 'Diagnostic handler bootstrapped (basic)' };

        default:
          return { success: false, message: 'No bootstrap logic available for route' };
      }
    } catch (bootstrapError: any) {
      logger.error(`❌ Bootstrap failed for route ${route}:`, bootstrapError.message);
      return { success: false, message: `Bootstrap failed: ${bootstrapError.message}` };
    }
  }
}

// Export singleton instance
export const routeRecovery = new RouteRecovery();
// ARCANOS:ROUTE-RECOVERY - Clear route recovery with unambiguous patterns
// Simplified recovery logic that avoids nested rule conflicts

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
  maxAttempts: number; // Clear limit to prevent infinite recovery loops
}

// Define clear recovery strategies for each route type
const RECOVERY_STRATEGIES = {
  '/memory': {
    handler: memoryHandler,
    method: 'handleMemoryRequest',
    allowedMethods: ['POST', 'GET'],
    maxAttempts: 2
  },
  '/write': {
    handler: writeHandler,
    method: 'handleWriteRequest', 
    allowedMethods: ['POST'],
    maxAttempts: 2
  },
  '/audit': {
    handler: auditHandler,
    method: 'handleAuditRequest',
    allowedMethods: ['POST'],
    maxAttempts: 2
  },
  '/diagnostic': {
    handler: diagnosticHandler,
    method: 'handleDiagnosticRequest',
    allowedMethods: ['GET', 'POST'],
    maxAttempts: 1 // Diagnostics should fail fast
  }
} as const;

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
    Object.entries(RECOVERY_STRATEGIES).forEach(([route, strategy]) => {
      this.routeStatuses.set(route, {
        route,
        handler: strategy.handler.constructor.name,
        recovery_attempts: 0,
        status: 'active',
        maxAttempts: strategy.maxAttempts
      });
    });

    console.log('🔄 ROUTE-RECOVERY: Initialized clear recovery strategies for', Object.keys(RECOVERY_STRATEGIES).length, 'routes');
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
    const routeConfig = this.routeStatuses.get(route);
    if (!routeConfig) {
      logger.error('No recovery config found for route:', route);
      res.status(500).json({ error: 'Route recovery not configured' });
      return;
    }

    const timestamp = new Date().toISOString();

    // Check if we've exceeded maximum recovery attempts
    if (routeConfig.recovery_attempts >= routeConfig.maxAttempts) {
      logger.error(`Maximum recovery attempts exceeded for ${route}`, {
        attempts: routeConfig.recovery_attempts,
        maxAttempts: routeConfig.maxAttempts
      });
      
      routeConfig.status = 'failed';
      await this.sendFailureResponse(route, req, res, 'Maximum recovery attempts exceeded');
      return;
    }

    // Log the failure with clear context
    this.logRecoveryActivity('route_failure', {
      route,
      handler: routeConfig.handler,
      error: error.message,
      recovery_attempts: routeConfig.recovery_attempts,
      timestamp,
      method: req.method
    });

    // Update route status
    routeConfig.status = 'recovering';
    routeConfig.recovery_attempts += 1;
    routeConfig.last_recovery = timestamp;

    logger.info('🔄 Attempting route recovery', { 
      route, 
      attempt: routeConfig.recovery_attempts,
      maxAttempts: routeConfig.maxAttempts
    });

    try {
      const recoveryResult = await this.attemptRouteRecovery(route, req, res);
      
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

      await this.sendFailureResponse(route, req, res, recoveryError.message);
    }
  }

  private async attemptRouteRecovery(route: string, req: Request, res: Response): Promise<{ success: boolean; message: string }> {
    const strategy = RECOVERY_STRATEGIES[route as keyof typeof RECOVERY_STRATEGIES];
    if (!strategy) {
      return { success: false, message: `No recovery strategy defined for route: ${route}` };
    }

    // Check if method is allowed for this route
    if (!strategy.allowedMethods.includes(req.method as any)) {
      return { 
        success: false, 
        message: `Method ${req.method} not allowed for route ${route}. Allowed: [${strategy.allowedMethods.join(', ')}]` 
      };
    }

    try {
      // Attempt to call the handler method directly
      const handler = strategy.handler as any;
      const method = strategy.method;
      
      if (typeof handler[method] === 'function') {
        await handler[method](req, res);
        return { success: true, message: `Route ${route} recovered successfully` };
      } else {
        return { success: false, message: `Handler method ${method} not found on ${strategy.handler.constructor.name}` };
      }
    } catch (error: any) {
      return { success: false, message: `Recovery attempt failed: ${error.message}` };
    }
  }

  private async sendFailureResponse(route: string, req: Request, res: Response, reason: string): Promise<void> {
    try {
      // Clear failure response based on route type
      const routeType = route.substring(1); // Remove leading slash
      
      const failureResponse = {
        success: false,
        error: `Route ${route} is temporarily unavailable`,
        reason,
        route,
        method: req.method,
        timestamp: new Date().toISOString(),
        recovery: {
          status: 'failed',
          attempts: this.routeStatuses.get(route)?.recovery_attempts || 0,
          maxAttempts: RECOVERY_STRATEGIES[route as keyof typeof RECOVERY_STRATEGIES]?.maxAttempts || 0
        }
      };

      // Send appropriate status code based on failure type
      const statusCode = reason.includes('Maximum recovery') ? 503 : 500;
      
      res.status(statusCode).json(failureResponse);
      
      logger.info(`Sent failure response for ${route}`, { statusCode, reason });
    } catch (error: any) {
      logger.error('Failed to send failure response:', error.message);
      
      // Last resort fallback
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Service temporarily unavailable',
          timestamp: new Date().toISOString()
        });
      }
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
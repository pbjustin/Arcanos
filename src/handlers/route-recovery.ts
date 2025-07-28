// ARCANOS:ROUTE-RECOVERY - Route recovery logic for missing controllers or invalid schemas
// Handles route failures and provides recovery mechanisms

import { Express, Request, Response, NextFunction } from "express";
import { memoryHandler } from "./memory-handler";
import { writeHandler } from "./write-handler";
import { auditHandler } from "./audit-handler";
import { diagnosticHandler } from "./diagnostic-handler";
import { fallbackHandler } from "./fallback-handler";

export interface RouteRecoveryConfig {
  route: string;
  handler: string;
  recovery_attempts: number;
  last_recovery?: string;
  status: "active" | "recovering" | "failed";
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
      { route: "/memory", handler: "memory-handler" },
      { route: "/write", handler: "write-handler" },
      { route: "/audit", handler: "audit-handler" },
      { route: "/diagnostic", handler: "diagnostic-handler" },
    ];

    routes.forEach(({ route, handler }) => {
      this.routeStatuses.set(route, {
        route,
        handler,
        recovery_attempts: 0,
        status: "active",
      });
    });

    console.log(
      "🔄 ROUTE-RECOVERY: Initialized route statuses for recovery tracking",
    );
  }

  private setupRouteRecoveryMiddleware(): void {
    if (!this.app) return;

    // Global error handler for route recovery
    this.app.use(this.routeRecoveryMiddleware.bind(this));
    console.log("🛡️ ROUTE-RECOVERY: Recovery middleware installed");
  }

  private routeRecoveryMiddleware(
    error: any,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const route = req.path;
    const timestamp = new Date().toISOString();

    console.log("🚨 ROUTE-RECOVERY: Route failure detected:", {
      route,
      error: error.message,
      timestamp,
    });

    // Check if this is a route we can recover
    if (this.routeStatuses.has(route)) {
      this.handleRouteFailure(route, error, req, res);
    } else {
      // Pass through to default error handler
      next(error);
    }
  }

  private async handleRouteFailure(
    route: string,
    error: any,
    req: Request,
    res: Response,
  ): Promise<void> {
    const routeConfig = this.routeStatuses.get(route)!;
    const timestamp = new Date().toISOString();

    // Log the failure
    this.logRecoveryActivity("route_failure", {
      route,
      handler: routeConfig.handler,
      error: error.message,
      recovery_attempts: routeConfig.recovery_attempts,
      timestamp,
    });

    // Update route status
    routeConfig.status = "recovering";
    routeConfig.recovery_attempts += 1;
    routeConfig.last_recovery = timestamp;

    console.log("🔄 ROUTE-RECOVERY: Attempting recovery for route:", {
      route,
      attempt: routeConfig.recovery_attempts,
    });

    try {
      // Attempt route-specific recovery
      const recoveryResult = await this.attemptRouteRecovery(route, req, res);

      if (recoveryResult.success) {
        routeConfig.status = "active";
        console.log("✅ ROUTE-RECOVERY: Route recovered successfully:", route);

        this.logRecoveryActivity("route_recovered", {
          route,
          handler: routeConfig.handler,
          recovery_attempts: routeConfig.recovery_attempts,
          timestamp: new Date().toISOString(),
        });
      } else {
        throw new Error(recoveryResult.message);
      }
    } catch (recoveryError: any) {
      console.error(
        "❌ ROUTE-RECOVERY: Recovery failed for route:",
        route,
        recoveryError.message,
      );

      routeConfig.status = "failed";

      this.logRecoveryActivity("route_recovery_failed", {
        route,
        handler: routeConfig.handler,
        recovery_attempts: routeConfig.recovery_attempts,
        error: recoveryError.message,
        timestamp: new Date().toISOString(),
      });

      // Send fallback response
      await this.sendFallbackResponse(route, req, res);
    }
  }

  private async attemptRouteRecovery(
    route: string,
    req: Request,
    res: Response,
  ): Promise<{ success: boolean; message: string }> {
    try {
      switch (route) {
        case "/memory":
          // Test memory handler functionality
          if (req.method === "POST") {
            await memoryHandler.handleMemoryRequest(req, res);
            return { success: true, message: "Memory route recovered" };
          }
          break;

        case "/write":
          // Test write handler functionality
          if (req.method === "POST") {
            await writeHandler.handleWriteRequest(req, res);
            return { success: true, message: "Write route recovered" };
          }
          break;

        case "/audit":
          // Test audit handler functionality
          if (req.method === "POST") {
            await auditHandler.handleAuditRequest(req, res);
            return { success: true, message: "Audit route recovered" };
          }
          break;

        case "/diagnostic":
          // Test diagnostic handler functionality and use its recovery method
          const diagnosticRecovery = await diagnosticHandler.recoverRoute();
          if (diagnosticRecovery.success && req.method === "GET") {
            await diagnosticHandler.handleDiagnosticRequest(req, res);
            return { success: true, message: "Diagnostic route recovered" };
          }
          return diagnosticRecovery;

        default:
          return { success: false, message: "Unknown route for recovery" };
      }

      return {
        success: false,
        message: "Recovery method not applicable for request type",
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Recovery attempt failed: ${error.message}`,
      };
    }
  }

  private async sendFallbackResponse(
    route: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    try {
      let fallbackType:
        | "memory"
        | "write"
        | "audit"
        | "diagnostic"
        | "general" = "general";

      if (route === "/memory") fallbackType = "memory";
      else if (route === "/write") fallbackType = "write";
      else if (route === "/audit") fallbackType = "audit";
      else if (route === "/diagnostic") fallbackType = "diagnostic";

      const fallbackResult = await fallbackHandler.handleUndefinedWorker({
        type: fallbackType,
        message: req.body?.message || `Route recovery for ${route}`,
        data: req.body || req.query,
      });

      res.status(503).json({
        error: "Route temporarily unavailable",
        route,
        fallback_response: fallbackResult,
        recovery_status: "failed",
        message: "Service degraded - using fallback handler",
        timestamp: new Date().toISOString(),
      });
    } catch (fallbackError: any) {
      console.error(
        "❌ FALLBACK-RESPONSE: Even fallback failed:",
        fallbackError,
      );
      res.status(503).json({
        error: "Service completely unavailable",
        route,
        message: "All recovery attempts failed",
        timestamp: new Date().toISOString(),
      });
    }
  }

  private logRecoveryActivity(activity: string, details: any): void {
    const logEntry = {
      activity,
      details,
      logged_at: new Date().toISOString(),
    };

    this.recoveryLog.push(logEntry);

    // Keep only last 50 entries to prevent memory issues
    if (this.recoveryLog.length > 50) {
      this.recoveryLog.shift();
    }

    console.log("📝 RECOVERY-LOG: Activity logged:", {
      activity,
      route: details.route,
      timestamp: logEntry.logged_at,
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
      config.status = "active";
      config.recovery_attempts = 0;
      config.last_recovery = undefined;

      this.logRecoveryActivity("route_reset", {
        route,
        timestamp: new Date().toISOString(),
      });

      console.log("🔄 ROUTE-RECOVERY: Route status reset:", route);
      return true;
    }
    return false;
  }

  // Method to validate route schemas (basic validation)
  validateRouteSchema(
    route: string,
    data: any,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    switch (route) {
      case "/memory":
        if (!data.memory_key) errors.push("memory_key is required");
        if (data.memory_value === undefined)
          errors.push("memory_value is required");
        break;

      case "/write":
        if (!data.message) errors.push("message is required");
        break;

      case "/audit":
        if (!data.message) errors.push("message is required for audit");
        break;

      case "/diagnostic":
        // Diagnostic route is flexible with parameters
        break;

      default:
        errors.push("Unknown route for schema validation");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Export singleton instance
export const routeRecovery = new RouteRecovery();

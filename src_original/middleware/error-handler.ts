// Centralized Error Handler for ARCANOS Backend
import { Request, Response, NextFunction } from 'express';

export interface ErrorHandlerOptions {
  enableRecovery?: boolean;
  logErrors?: boolean;
  includeStackTrace?: boolean;
}

class ErrorHandler {
  private options: ErrorHandlerOptions;

  constructor(options: ErrorHandlerOptions = {}) {
    this.options = {
      enableRecovery: true,
      logErrors: true,
      includeStackTrace: process.env.NODE_ENV === 'development',
      ...options
    };
  }

  // Centralized async error handler for routes
  public asyncHandler = (fn: Function) => {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch((error) => {
        this.handleError(error, req, res, next);
      });
    };
  };

  // Main error handler middleware
  public handleError = (error: any, req: Request, res: Response, next: NextFunction) => {
    if (this.options.logErrors) {
      console.error(`❌ Error in ${req.method} ${req.path}:`, error.message);
      if (this.options.includeStackTrace) {
        console.error(error.stack);
      }
    }

    // Log error for route recovery (simplified approach since handleRouteError doesn't exist)
    if (this.options.enableRecovery) {
      try {
        console.log(`🔄 Route error logged for potential recovery: ${req.path}`);
      } catch (recoveryError) {
        console.error('❌ Route recovery logging failed:', recoveryError);
      }
    }

    // Determine error response
    let statusCode = 500;
    let errorMessage = 'Internal server error';
    let errorDetails: any = {};

    if (error.status || error.statusCode) {
      statusCode = error.status || error.statusCode;
    }

    if (error.message) {
      errorMessage = error.message;
    }

    // Handle specific error types
    if (error.name === 'ValidationError') {
      statusCode = 400;
      errorMessage = 'Validation failed';
      errorDetails = error.details || {};
    } else if (error.name === 'UnauthorizedError') {
      statusCode = 401;
      errorMessage = 'Unauthorized access';
    } else if (error.code === 'MODULE_NOT_FOUND') {
      statusCode = 500;
      errorMessage = 'Service temporarily unavailable';
      errorDetails = { module: error.message };
    }

    const errorResponse: any = {
      error: errorMessage,
      success: false,
      timestamp: new Date().toISOString(),
      path: req.path,
      method: req.method
    };

    if (this.options.includeStackTrace && error.stack) {
      errorResponse.stack = error.stack;
    }

    if (Object.keys(errorDetails).length > 0) {
      errorResponse.details = errorDetails;
    }

    // Don't send response if already sent
    if (!res.headersSent) {
      res.status(statusCode).json(errorResponse);
    }
  };

  // 404 handler
  public notFoundHandler = (req: Request, res: Response) => {
    const errorResponse = {
      error: 'Route not found',
      success: false,
      timestamp: new Date().toISOString(),
      path: req.path,
      method: req.method,
      availableRoutes: this.getAvailableRoutes()
    };

    res.status(404).json(errorResponse);
  };

  private getAvailableRoutes(): string[] {
    return [
      'GET /health',
      'POST /memory',
      'POST /audit', 
      'GET|POST /diagnostic',
      'POST /write',
      'GET /route-status',
      'GET /audit-logs',
      'GET /chatgpt-user-status',
      'GET /finetune-status',
      'POST /webhook',
      'GET /sync/diagnostics',
      'POST /query-finetune',
      'POST /ask',
      'POST /',
      'GET /'
    ];
  }
}

// Export singleton instance
export const errorHandler = new ErrorHandler();

// Export middleware functions for convenience
export const asyncHandler = errorHandler.asyncHandler;
export const handleError = errorHandler.handleError;
export const notFoundHandler = errorHandler.notFoundHandler;
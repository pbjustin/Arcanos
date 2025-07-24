// ARCANOS:DIAGNOSTIC-HANDLER - Dedicated diagnostic route handler
// Ensures readiness logging during startup and route recovery

import { Request, Response } from 'express';
import { diagnosticsService } from '../services/diagnostics';
import { fallbackHandler } from './fallback-handler';

export class DiagnosticHandler {
  private diagnosticLog: any[] = [];
  private readinessConfirmed: boolean = false;

  constructor() {
    this.confirmReadinessDuringStartup();
  }

  async handleDiagnosticRequest(req: Request, res: Response): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log('🩺 DiagnosticHandler: Performing system diagnostic with readiness confirmation');
    
    try {
      const command = (req.query.command as string) || 'system health';
      
      console.log('🔧 DIAGNOSTIC-PROCESSING: Running diagnostic command:', command);
      
      let result;
      try {
        result = await diagnosticsService.executeDiagnosticCommand(command);
      } catch (serviceError: any) {
        console.warn('⚠️ Primary diagnostic service failed, using fallback:', serviceError.message);
        
        // Use fallback handler if primary diagnostic service fails
        const fallbackResult = await fallbackHandler.handleUndefinedWorker({
          type: 'diagnostic',
          message: command,
          data: { command }
        });
        
        result = {
          success: fallbackResult.success,
          command,
          category: 'fallback',
          data: fallbackResult.data || {},
          timestamp,
          fallback_used: true,
          error: fallbackResult.error
        };
      }
      
      // Log diagnostic activity
      this.logDiagnosticActivity('diagnostic_executed', {
        command,
        success: result.success,
        category: result.category,
        timestamp
      });

      console.log('✅ DIAGNOSTIC-COMPLETE: Diagnostic completed:', { 
        success: result.success, 
        category: result.category,
        readiness_confirmed: this.readinessConfirmed 
      });
      
      res.json({
        ...result,
        endpoint: '/diagnostic',
        diagnostic_logged: true,
        readiness_confirmed: this.readinessConfirmed,
        activity_timestamp: timestamp
      });
      
    } catch (error: any) {
      console.error('❌ DIAGNOSTIC-HANDLER: Complete diagnostic failure:', error);
      
      // Log diagnostic failure
      this.logDiagnosticActivity('diagnostic_failed', {
        command: req.query.command || 'unknown',
        error: error.message,
        timestamp
      });
      
      // Final fallback response
      try {
        const fallbackResult = await fallbackHandler.handleUndefinedWorker({
          type: 'diagnostic',
          message: 'diagnostic failure recovery',
          data: { error: error.message }
        });
        
        res.status(500).json({
          success: false,
          command: req.query.command || 'unknown',
          category: 'error',
          data: fallbackResult.data || {},
          timestamp,
          error: error.message,
          fallback_used: true,
          diagnostic_logged: true
        });
      } catch (fallbackError: any) {
        res.status(500).json({
          success: false,
          command: req.query.command || 'unknown',
          category: 'error',
          data: {},
          timestamp,
          error: error.message,
          fallback_error: fallbackError.message,
          diagnostic_logged: true
        });
      }
    }
  }

  // Log readiness during app startup as required
  private confirmReadinessDuringStartup(): void {
    // Delay to ensure this runs during startup sequence
    setTimeout(() => {
      console.log('🩺 DIAGNOSTIC-READINESS: Confirming diagnostic handler readiness during startup');
      
      this.logDiagnosticActivity('handler_ready', {
        startup_timestamp: new Date().toISOString(),
        handler_initialized: true,
        fallback_available: true
      });
      
      this.readinessConfirmed = true;
      console.log('✅ DIAGNOSTIC-STARTUP: Handler readiness confirmed and logged');
    }, 1000);
  }

  private logDiagnosticActivity(activity: string, details: any): void {
    const logEntry = {
      activity,
      details,
      logged_at: new Date().toISOString()
    };

    this.diagnosticLog.push(logEntry);
    
    // Keep only last 100 entries to prevent memory issues
    if (this.diagnosticLog.length > 100) {
      this.diagnosticLog.shift();
    }

    console.log('📝 DIAGNOSTIC-ACTIVITY: Activity logged:', {
      activity,
      timestamp: logEntry.logged_at,
      total_activities: this.diagnosticLog.length
    });
  }

  // Method to retrieve diagnostic activity logs
  getDiagnosticLogs(): any[] {
    return [...this.diagnosticLog];
  }

  // Method to get readiness status
  getReadinessStatus(): { ready: boolean; confirmed_at?: string } {
    const readinessLog = this.diagnosticLog.find(log => log.activity === 'handler_ready');
    return {
      ready: this.readinessConfirmed,
      confirmed_at: readinessLog ? readinessLog.logged_at : undefined
    };
  }

  // Method to clear diagnostic logs (for maintenance)
  clearDiagnosticLogs(): void {
    const cleared = this.diagnosticLog.length;
    this.diagnosticLog = [];
    console.log(`🧹 DIAGNOSTIC-MAINTENANCE: Cleared ${cleared} diagnostic logs`);
  }

  // Route recovery method - can be called if route fails
  async recoverRoute(): Promise<{ success: boolean; message: string }> {
    console.log('🔄 DIAGNOSTIC-RECOVERY: Attempting route recovery');
    
    try {
      // Test basic diagnostic functionality
      const testResult = await diagnosticsService.executeDiagnosticCommand('recovery test');
      
      if (testResult.success) {
        this.logDiagnosticActivity('route_recovered', {
          recovery_timestamp: new Date().toISOString(),
          test_result: testResult
        });
        
        console.log('✅ DIAGNOSTIC-RECOVERY: Route recovery successful');
        return {
          success: true,
          message: 'Diagnostic route recovered successfully'
        };
      } else {
        throw new Error('Recovery test failed');
      }
    } catch (error: any) {
      console.error('❌ DIAGNOSTIC-RECOVERY: Route recovery failed:', error);
      
      this.logDiagnosticActivity('route_recovery_failed', {
        recovery_timestamp: new Date().toISOString(),
        error: error.message
      });
      
      return {
        success: false,
        message: `Route recovery failed: ${error.message}`
      };
    }
  }
}

// Export singleton instance
export const diagnosticHandler = new DiagnosticHandler();
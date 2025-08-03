// ARCANOS:WRITE-HANDLER - Streamlined write route handler
// Content validation and OpenAI SDK-compatible write operations

import { Request, Response } from 'express';
import { ArcanosWriteService } from '../services/arcanos-write.js';

export class WriteHandler {
  private writeService: ArcanosWriteService;
  private malformedResponseLog: any[] = [];

  constructor() {
    this.writeService = new ArcanosWriteService();
  }

  async handleWriteRequest(req: Request, res: Response): Promise<void> {
    console.log('✍️ WriteHandler: Processing write request with content validation');
    const timestamp = new Date().toISOString();
    
    try {
      const { message, domain, useRAG } = req.body;
      
      // Simple content validation - fail fast for invalid content
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        console.warn('⚠️ WRITE-VALIDATION: Rejecting request with invalid content');
        res.status(400).json({
          error: 'Invalid content provided',
          reason: 'Message must be a non-empty string',
          timestamp
        });
        return;
      }

      const writeRequest = {
        message,
        domain: domain || 'general',
        useRAG: useRAG !== false
      };

      console.log('🖊️ WRITE-PROCESSING: Valid content confirmed, processing request:', { 
        domain: writeRequest.domain, 
        useRAG: writeRequest.useRAG,
        timestamp 
      });
      
      let result = await this.writeService.processWriteRequest(writeRequest);
      
      // Simple content validation - fail fast if no content
      if (!result || !result.content || result.content.trim().length === 0) {
        console.warn('⚠️ WRITE-VALIDATION: Empty response from write service');
        res.status(500).json({
          success: false,
          error: 'Write service returned empty content',
          timestamp
        });
        return;
      }
      
      console.log('✅ WRITE-COMPLETE: Request processed successfully');
      res.json({
        ...result,
        content_validated: true,
        timestamp
      });
      
    } catch (error: any) {
      console.error('❌ WRITE-HANDLER: Error processing request:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp
      });
    }
  }

  // Method to retrieve malformed response logs for auditing
  getMalformedResponseLogs(): any[] {
    return [...this.malformedResponseLog];
  }

  // Method to clear audit logs (for maintenance)
  clearMalformedResponseLogs(): void {
    const cleared = this.malformedResponseLog.length;
    this.malformedResponseLog = [];
    console.log(`🧹 AUDIT-MAINTENANCE: Cleared ${cleared} malformed response logs`);
  }
}

// Export singleton instance
export const writeHandler = new WriteHandler();
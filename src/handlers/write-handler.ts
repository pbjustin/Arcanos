// ARCANOS:WRITE-HANDLER - Dedicated write route handler
// Prevents null/incomplete content and logs malformed responses

import { Request, Response } from "express";
import { ArcanosWriteService } from "../services/arcanos-write";
import { fallbackHandler } from "./fallback-handler";

export class WriteHandler {
  private writeService: ArcanosWriteService;
  private malformedResponseLog: any[] = [];

  constructor() {
    this.writeService = new ArcanosWriteService();
  }

  async handleWriteRequest(req: Request, res: Response): Promise<void> {
    console.log(
      "✍️ WriteHandler: Processing write request with content validation",
    );
    const timestamp = new Date().toISOString();

    try {
      const { message, domain, useRAG } = req.body;

      // Prevent write tasks from firing when content is null or incomplete
      const contentValidation = fallbackHandler.validateContent(message);
      if (!contentValidation.isValid) {
        console.warn(
          "⚠️ WRITE-VALIDATION: Rejecting request with invalid content:",
          contentValidation.reason,
        );
        res.status(400).json({
          error: "Invalid content provided",
          reason: contentValidation.reason,
          prevention: "Avoiding 400-level OpenAI errors",
          timestamp,
        });
        return;
      }

      const writeRequest = {
        message,
        domain: domain || "general",
        useRAG: useRAG !== false,
      };

      console.log(
        "🖊️ WRITE-PROCESSING: Valid content confirmed, processing request:",
        {
          domain: writeRequest.domain,
          useRAG: writeRequest.useRAG,
          timestamp,
        },
      );

      let result = await this.writeService.processWriteRequest(writeRequest);

      // Check for malformed model responses and log for audit
      if (this.isMalformedResponse(result)) {
        console.warn(
          "🚨 MALFORMED-RESPONSE: Detected malformed model response",
        );
        this.logMalformedResponse(result, writeRequest, timestamp);

        // Automatically inject fallback content if response lacks content field
        result = fallbackHandler.injectFallbackContent(result, message);
      }

      // Final validation before sending response
      const finalValidation = fallbackHandler.validateContent(result.content);
      if (!finalValidation.isValid) {
        console.error(
          "❌ WRITE-FINAL: Response content invalid after processing",
        );
        result = fallbackHandler.injectFallbackContent(result, message);
      }

      console.log(
        "✅ WRITE-COMPLETE: Request processed successfully with content validation",
      );
      res.json({
        ...result,
        content_validated: true,
        timestamp,
      });
    } catch (error: any) {
      console.error("❌ WRITE-HANDLER: Error processing request:", error);

      // Use fallback handler for error recovery
      try {
        const fallbackResult = await fallbackHandler.handleUndefinedWorker({
          type: "write",
          message: req.body.message,
          data: req.body,
        });

        res.status(500).json({
          success: false,
          content: fallbackResult.content || "",
          error: error.message,
          fallback_used: true,
          timestamp,
        });
      } catch (fallbackError: any) {
        res.status(500).json({
          success: false,
          content: "",
          error: error.message,
          fallback_error: fallbackError.message,
          timestamp,
        });
      }
    }
  }

  private isMalformedResponse(response: any): boolean {
    // Check for various malformed response patterns
    return (
      !response ||
      typeof response !== "object" ||
      !response.hasOwnProperty("content") ||
      response.content === null ||
      response.content === undefined ||
      (typeof response.content === "string" &&
        response.content.trim() === "") ||
      response.success === undefined ||
      (response.error && !response.content)
    );
  }

  private logMalformedResponse(
    response: any,
    request: any,
    timestamp: string,
  ): void {
    const logEntry = {
      timestamp,
      response_structure: {
        has_content: response.hasOwnProperty("content"),
        content_type: typeof response.content,
        content_length: response.content ? response.content.length : 0,
        has_success: response.hasOwnProperty("success"),
        has_error: response.hasOwnProperty("error"),
      },
      request_info: {
        message_length: request.message ? request.message.length : 0,
        domain: request.domain,
        useRAG: request.useRAG,
      },
      malformed_response: response,
      audit_id: `malformed_${Date.now()}`,
    };

    this.malformedResponseLog.push(logEntry);

    // Keep only last 100 entries to prevent memory issues
    if (this.malformedResponseLog.length > 100) {
      this.malformedResponseLog.shift();
    }

    console.log("📋 MALFORMED-AUDIT: Response logged for future audit:", {
      audit_id: logEntry.audit_id,
      timestamp,
      total_logged: this.malformedResponseLog.length,
    });
  }

  // Method to retrieve malformed response logs for auditing
  getMalformedResponseLogs(): any[] {
    return [...this.malformedResponseLog];
  }

  // Method to clear audit logs (for maintenance)
  clearMalformedResponseLogs(): void {
    const cleared = this.malformedResponseLog.length;
    this.malformedResponseLog = [];
    console.log(
      `🧹 AUDIT-MAINTENANCE: Cleared ${cleared} malformed response logs`,
    );
  }
}

// Export singleton instance
export const writeHandler = new WriteHandler();

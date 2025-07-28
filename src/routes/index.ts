import { Router } from "express";
import { modelControlHooks } from "../services/model-control-hooks";
import { diagnosticsService } from "../services/diagnostics";
import { workerStatusService } from "../services/worker-status";
import {
  sendEmail,
  verifyEmailConnection,
  getEmailSender,
  getEmailTransportType,
} from "../services/email";
import { sendEmailIntent } from "../intents/send_email";
import { sendEmailAndRespond } from "../intents/send_email_and_respond";
import assistantsRouter from "./assistants";

const router = Router();

// AI-controlled welcome endpoint
router.get("/", async (req, res) => {
  try {
    const result = await modelControlHooks.handleApiRequest(
      "/api",
      "GET",
      {},
      {
        userId: (req.headers["x-user-id"] as string) || "anonymous",
        sessionId: (req.headers["x-session-id"] as string) || "default",
        source: "api",
      },
    );

    if (result.success) {
      res.json({
        message: result.response || "Welcome to ARCANOS API - AI Controlled",
        timestamp: new Date().toISOString(),
        aiControlled: true,
      });
    } else {
      res.json({
        message: "Welcome to ARCANOS API - AI Controlled",
        timestamp: new Date().toISOString(),
        aiControlled: true,
        version: "1.0.0",
      });
    }
  } catch (error) {
    res.json({
      message: "Welcome to ARCANOS API - AI Controlled",
      timestamp: new Date().toISOString(),
      aiControlled: true,
      version: "1.0.0",
    });
  }
});

// AI-controlled ask endpoint
router.post("/ask", async (req, res) => {
  try {
    const result = await modelControlHooks.handleApiRequest(
      "/api/ask",
      "POST",
      req.body,
      {
        userId: (req.headers["x-user-id"] as string) || "default",
        sessionId: (req.headers["x-session-id"] as string) || "default",
        source: "api",
        metadata: { headers: req.headers },
      },
    );

    if (result.success) {
      res.json({
        response: result.response,
        aiControlled: true,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(500).json({
        error: result.error,
        aiControlled: true,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      aiControlled: true,
      timestamp: new Date().toISOString(),
    });
  }
});

// AI-controlled diagnostics endpoint
router.post("/diagnostics", async (req, res) => {
  try {
    const { command, message } = req.body;
    const diagnosticCommand = command || message;

    if (!diagnosticCommand) {
      return res.status(400).json({
        error: "Diagnostic command is required",
        examples: ["Check memory", "CPU status", "System health"],
        aiControlled: true,
      });
    }

    const result =
      await diagnosticsService.executeDiagnosticCommand(diagnosticCommand);
    res.json({
      ...result,
      aiControlled: true,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      aiControlled: true,
      timestamp: new Date().toISOString(),
    });
  }
});

// AI-controlled worker status endpoint
router.get("/workers/status", async (req, res) => {
  try {
    const result = await modelControlHooks.handleApiRequest(
      "/api/workers/status",
      "GET",
      {},
      {
        userId: (req.headers["x-user-id"] as string) || "system",
        sessionId: (req.headers["x-session-id"] as string) || "default",
        source: "api",
      },
    );

    if (result.success) {
      const workersStatus = await workerStatusService.getAllWorkersStatus();
      res.json({
        status: workersStatus,
        aiControlled: true,
        aiResponse: result.response,
        timestamp: new Date().toISOString(),
      });
    } else {
      const workersStatus = await workerStatusService.getAllWorkersStatus();
      res.json({
        status: workersStatus,
        aiControlled: true,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      aiControlled: true,
      timestamp: new Date().toISOString(),
    });
  }
});

// Email service endpoints
router.get("/email/status", async (req, res) => {
  try {
    const isConnected = await verifyEmailConnection();
    const sender = getEmailSender();
    const transportType = getEmailTransportType();

    res.json({
      connected: isConnected,
      sender: sender,
      transportType: transportType,
      configured: sender !== "Not configured",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      connected: false,
      transportType: "Unknown",
      timestamp: new Date().toISOString(),
    });
  }
});

router.post("/email/send", async (req, res) => {
  try {
    const { to, subject, html, from } = req.body;

    if (!to || !subject || !html) {
      return res.status(400).json({
        error: "Missing required fields: to, subject, html",
        timestamp: new Date().toISOString(),
      });
    }

    const result = await sendEmail(to, subject, html, from);

    if (result.success) {
      res.json({
        success: true,
        messageId: result.messageId,
        verified: result.verified,
        transportType: result.transportType,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
        verified: result.verified,
        transportType: result.transportType,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Intent endpoints
router.post("/intent/send_email", sendEmailIntent);
router.post("/intent/send_email_and_respond", sendEmailAndRespond);

// Mount assistant routes
router.use("/", assistantsRouter);

// Catch-all route - delegate everything to AI
router.use("*", async (req, res) => {
  try {
    const result = await modelControlHooks.handleApiRequest(
      req.originalUrl,
      req.method,
      req.body,
      {
        userId: (req.headers["x-user-id"] as string) || "default",
        sessionId: (req.headers["x-session-id"] as string) || "default",
        source: "api",
        metadata: { headers: req.headers },
      },
    );

    if (result.success) {
      res.json({
        response: result.response,
        aiControlled: true,
        endpoint: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(404).json({
        error: "Endpoint not found or AI processing failed",
        details: result.error,
        aiControlled: true,
        endpoint: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    res.status(500).json({
      error: "AI processing error",
      details: error.message,
      aiControlled: true,
      endpoint: req.originalUrl,
      method: req.method,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;

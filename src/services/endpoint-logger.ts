// 📟 ROUTE TRIGGER LOGGER — SAFE TO DROP IN ANY API ENDPOINT
// Purpose: Log imported endpoint usage (for visibility, debugging, audit trail)

import { Request } from "express";

/**
 * Log endpoint usage with timestamp, source IP, and user agent
 * @param endpointName - The name/path of the endpoint being called
 * @param req - Express request object
 */
export function logEndpointCall(endpointName: string, req: Request): void {
  const now = new Date().toISOString();
  const origin = req.headers["user-agent"] || "unknown";
  const sourceIP = req.ip || req.connection?.remoteAddress || "N/A";
  console.log(`[${now}] 📡 ${endpointName} hit from ${sourceIP} (${origin})`);
}

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runtimeEnv } from "../config/env.js";

export interface RequestAuthContext {
  principalId: string;
}

export type AuthenticatedRequest = Request & {
  auth: RequestAuthContext;
};

export function getRequestAuth(req: Request): RequestAuthContext | null {
  const auth = (req as Partial<AuthenticatedRequest>).auth;
  if (!auth || typeof auth.principalId !== "string") {
    return null;
  }
  return auth;
}

function extractApiKey(req: Request): string | null {
  const authHeader = req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token.length > 0) {
      return token;
    }
  }

  const headerKey = req.header("x-api-key")?.trim();
  if (headerKey && headerKey.length > 0) {
    return headerKey;
  }

  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function hashPrincipal(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const presentedApiKey = extractApiKey(req);
  if (!presentedApiKey) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const matchedKey = runtimeEnv.API_KEYS.find((configuredKey) =>
    constantTimeEqual(configuredKey, presentedApiKey)
  );

  if (!matchedKey) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  (req as AuthenticatedRequest).auth = {
    principalId: hashPrincipal(matchedKey)
  };
  next();
}

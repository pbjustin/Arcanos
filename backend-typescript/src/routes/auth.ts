/**
 * Auth Routes
 * Login endpoint for issuing JWT tokens.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const PASSWORD_HASH_LENGTH_BYTES = 64;

interface LoginConfig {
  email: string;
  passwordHashHex: string;
  passwordSalt: string;
}

interface LoginRequestPayload {
  email: string;
  password: string;
}

interface LoginResponsePayload {
  success: boolean;
  token: string;
  tokenType: 'Bearer';
  expiresAt: number | null;
  userId: string;
}

interface LoginPayloadResult {
  ok: boolean;
  error?: string;
  value?: LoginRequestPayload;
}

export interface AuthRouteDependencies {
  getEnvValue: (key: string) => string | undefined;
  tokenSigner: (userId: string, email?: string) => string;
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  };
}

function normalizeEmailForComparison(email: string): string {
  //audit assumption: email is a string; risk: inconsistent casing; invariant: normalized for comparison; strategy: trim + lowercase.
  return email.trim().toLowerCase();
}

function buildLoginConfigFromEnvironment(getEnvValue: (key: string) => string | undefined): LoginConfig | null {
  const rawEmail = (getEnvValue('AUTH_USER_EMAIL') || '').trim();
  const rawPasswordHash = (getEnvValue('AUTH_PASSWORD_HASH') || '').trim();
  const rawPasswordSalt = (getEnvValue('AUTH_PASSWORD_SALT') || '').trim();

  if (!rawEmail || !rawPasswordHash || !rawPasswordSalt) {
    //audit assumption: auth env vars are set; risk: login disabled; invariant: config present; strategy: return null.
    return null;
  }

  if (!/^[0-9a-fA-F]+$/.test(rawPasswordHash) || rawPasswordHash.length !== PASSWORD_HASH_LENGTH_BYTES * 2) {
    //audit assumption: password hash is hex; risk: invalid hash format; invariant: hex length matches scrypt output; strategy: reject config.
    return null;
  }

  return {
    email: normalizeEmailForComparison(rawEmail),
    passwordHashHex: rawPasswordHash,
    passwordSalt: rawPasswordSalt
  };
}

function parseLoginPayload(body: unknown): LoginPayloadResult {
  if (!body || typeof body !== 'object') {
    //audit assumption: body is JSON object; risk: invalid payload; invariant: object with email/password; strategy: return error.
    return { ok: false, error: 'Invalid request body' };
  }

  const candidate = body as Record<string, unknown>;
  const email = candidate.email;
  const password = candidate.password;

  if (typeof email !== 'string' || typeof password !== 'string') {
    //audit assumption: email/password are strings; risk: type mismatch; invariant: string inputs; strategy: return error.
    return { ok: false, error: 'email and password are required' };
  }

  if (email.trim().length === 0 || password.trim().length === 0) {
    //audit assumption: non-empty credentials; risk: empty inputs; invariant: trimmed length > 0; strategy: return error.
    return { ok: false, error: 'email and password are required' };
  }

  return { ok: true, value: { email, password } };
}

function safeConstantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    //audit assumption: equal length for timingSafeEqual; risk: timing leak on length; invariant: lengths match; strategy: return false.
    return false;
  }

  //audit assumption: constant-time compare reduces timing leaks; risk: side-channel; invariant: timingSafeEqual used; strategy: compare buffers.
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function derivePasswordHash(password: string, salt: string): Buffer {
  //audit assumption: scrypt parameters stable; risk: hash mismatch; invariant: fixed output length; strategy: derive with scryptSync.
  return crypto.scryptSync(password, salt, PASSWORD_HASH_LENGTH_BYTES);
}

function verifyPassword(password: string, config: LoginConfig): boolean {
  const expectedHash = Buffer.from(config.passwordHashHex, 'hex');
  const derivedHash = derivePasswordHash(password, config.passwordSalt);

  if (expectedHash.length !== derivedHash.length) {
    //audit assumption: hash lengths match; risk: invalid config; invariant: equal buffer length; strategy: treat as mismatch.
    return false;
  }

  //audit assumption: timingSafeEqual prevents timing leaks; risk: side-channel; invariant: constant-time compare; strategy: compare buffers.
  return crypto.timingSafeEqual(expectedHash, derivedHash);
}

function extractJwtExpiration(token: string): number | null {
  //audit assumption: decode is unverified; risk: forged exp; invariant: exp used for display only; strategy: decode without verify.
  const decoded = jwt.decode(token);

  if (!decoded || typeof decoded !== 'object') {
    //audit assumption: token decodes to object; risk: no exp; invariant: exp optional; strategy: return null.
    return null;
  }

  const expValue = (decoded as Record<string, unknown>).exp;
  if (typeof expValue !== 'number') {
    //audit assumption: exp is number; risk: missing exp; invariant: exp optional; strategy: return null.
    return null;
  }

  return expValue;
}

/**
 * Create auth router with injected dependencies.
 * Purpose: Provide a login endpoint that issues JWTs.
 * Inputs: Dependency providers for env, time, logger, and token signing.
 * Outputs: Express Router configured with POST /login.
 * Edge cases: Missing auth env config returns 500; invalid credentials return 401.
 */
export function createAuthRouter(deps: AuthRouteDependencies): Router {
  const router = Router();

  router.post('/login', (req: Request, res: Response<LoginResponsePayload | { error: string; message: string }>) => {
    try {
      const loginConfig = buildLoginConfigFromEnvironment(deps.getEnvValue);

      if (!loginConfig) {
        //audit assumption: auth env is configured; risk: login unavailable; invariant: config present; strategy: log and return 500.
        deps.logger.error('Auth login configuration missing or invalid');
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Login is not configured'
        });
        return;
      }

      const payloadResult = parseLoginPayload(req.body);
      if (!payloadResult.ok || !payloadResult.value) {
        //audit assumption: payload valid; risk: malformed request; invariant: payloadResult ok; strategy: return 400.
        res.status(400).json({
          error: 'Bad Request',
          message: payloadResult.error || 'Invalid request body'
        });
        return;
      }

      //audit assumption: email normalization needed; risk: case mismatch; invariant: normalized email; strategy: normalize before compare.
      const normalizedEmail = normalizeEmailForComparison(payloadResult.value.email);
      const emailMatches = safeConstantTimeEquals(normalizedEmail, loginConfig.email);

      if (!emailMatches) {
        //audit assumption: email must match configured user; risk: unauthorized access; invariant: email comparison; strategy: return 401.
        deps.logger.warn('Auth login failed: email mismatch');
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid credentials'
        });
        return;
      }

      const passwordMatches = verifyPassword(payloadResult.value.password, loginConfig);
      if (!passwordMatches) {
        //audit assumption: password must match; risk: unauthorized access; invariant: password verification; strategy: return 401.
        deps.logger.warn('Auth login failed: password mismatch');
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid credentials'
        });
        return;
      }

      const userId = loginConfig.email;
      const token = deps.tokenSigner(userId, payloadResult.value.email);
      const expiresAt = extractJwtExpiration(token);

      deps.logger.info('Auth login succeeded', { userId });

      res.json({
        success: true,
        token,
        tokenType: 'Bearer',
        expiresAt,
        userId
      });
    } catch (error) {
      //audit assumption: unexpected error handling required; risk: login crash; invariant: errors logged; strategy: return 500.
      deps.logger.error('Auth login error', { error: (error as Error).message });
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to process login'
      });
    }
  });

  return router;
}

/**
 * ARCANOS Backend - Main Server
 * Express + PostgreSQL API for ARCANOS daemon
 */

import 'dotenv/config';
import http from 'http';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDatabase, logAuditEvent } from './database';
import { attachAnonymousUser, authenticateJWT, generateToken, verifyToken } from './auth';
import { createApiKeyAuthMiddleware, loadApiKeyAuthConfig } from './auth/apiKeyAuth';
import { logger } from './logger';
import { createAuthRouter } from './routes/auth';
import { createDaemonRouter } from './routes/daemon';
import { loadIpcServerConfig } from './ipc/ipcConfig';
import { createIpcConnectionRegistry } from './ipc/ipcRegistry';
import { createIpcServer } from './ipc/ipcServer';
import { createDaemonGptIdMiddleware } from './middleware/daemonGptId';

// Routes
import askRoute from './routes/ask';
import updateRoute from './routes/update';
import healthRoute from './routes/health';
import auditRoute from './routes/audit';
import arcanosQueryRoute from './routes/arcanosQuery';
import relayRoute from './routes/relay';
import visionRoute from './routes/vision';
import transcribeRoute from './routes/transcribe';

// Create Express app
const app: Express = express();
const httpServer = http.createServer(app);
const parsedPort = Number.parseInt(process.env.PORT || '5000', 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 5000;
const parsedIpcPort = Number.parseInt(process.env.IPC_PORT || '', 10);
//audit assumption: IPC port defaults to main port when unset/invalid; risk: misconfigured port; invariant: IPC_PORT resolved; strategy: fallback.
const IPC_PORT = Number.isFinite(parsedIpcPort) ? parsedIpcPort : PORT;
const ipcHttpServer = IPC_PORT === PORT ? httpServer : http.createServer();

type AuthMode = 'jwt' | 'api_key' | 'none';

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  /**
   * Purpose: Parse a boolean-like environment variable with a default.
   * Inputs/Outputs: raw env value and default; returns parsed boolean.
   * Edge cases: Unset or empty values fall back to default.
   */
  if (value === undefined) {
    //audit assumption: missing values use default; risk: wrong defaults; invariant: default applied; strategy: return default.
    return defaultValue;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    //audit assumption: empty string uses default; risk: misconfiguration; invariant: default applied; strategy: return default.
    return defaultValue;
  }
  return trimmed === 'true';
}

//audit assumption: seamless mode defaults to anonymous auth; risk: insecure defaults; invariant: explicit env overrides; strategy: default false.
const authRequiredFlag = parseBooleanEnv(process.env.AUTH_REQUIRED, false);
//audit assumption: database can be optional in seamless mode; risk: missing persistence; invariant: env overrides; strategy: default false.
const databaseRequiredFlag = parseBooleanEnv(process.env.DATABASE_REQUIRED, false);
const rawAuthMode = (process.env.AUTH_MODE || '').trim().toLowerCase();
if (rawAuthMode && !['jwt', 'api_key', 'none'].includes(rawAuthMode)) {
  //audit assumption: auth mode must be valid; risk: invalid config; invariant: allowed values; strategy: log and exit.
  logger.error('AUTH_MODE must be one of: jwt, api_key, none');
  process.exit(1);
}
//audit assumption: auth mode derives from AUTH_MODE or AUTH_REQUIRED; risk: mismatch; invariant: valid mode; strategy: fallback to boolean flag.
const authMode: AuthMode = rawAuthMode ? (rawAuthMode as AuthMode) : (authRequiredFlag ? 'jwt' : 'none');
//audit assumption: required env list depends on auth mode and DB requirement; risk: missing secrets; invariant: required envs enforced; strategy: conditional list.
const requiredEnv = ['OPENAI_API_KEY'];
if (databaseRequiredFlag) {
  //audit assumption: database required flag enforces URL; risk: missing DB; invariant: required env enforced; strategy: add to required list.
  requiredEnv.push('DATABASE_URL');
}
if (authMode === 'jwt') {
  //audit assumption: jwt auth requires secret; risk: missing JWT secret; invariant: env required; strategy: add to required list.
  requiredEnv.push('JWT_SECRET');
}
if (authMode === 'api_key') {
  //audit assumption: api key auth requires key; risk: missing API key; invariant: env required; strategy: add to required list.
  requiredEnv.push('AUTH_API_KEY');
}
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  logger.error('Missing required environment variables', { missing: missingEnv });
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  //audit assumption: database optional; risk: no persistence; invariant: warning logged; strategy: warn without exit.
  logger.warn('DATABASE_URL is not set; backend will run without persistence');
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.length === 0;
if (allowAllOrigins) {
  //audit assumption: missing ALLOWED_ORIGINS implies allow-all; risk: overly permissive CORS; invariant: credentials disabled; strategy: warn and allow.
  logger.warn('ALLOWED_ORIGINS not set; allowing all origins with credentials disabled');
}

// Security middleware
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      //audit assumption: non-browser clients omit origin; risk: unintended access; invariant: allow missing origin; strategy: allow.
      callback(null, true);
      return;
    }
    if (allowAllOrigins) {
      //audit assumption: allow-all configured; risk: broad access; invariant: origin allowed; strategy: allow.
      callback(null, true);
      return;
    }
    if (allowedOrigins.includes(origin)) {
      //audit assumption: origin whitelist should pass; risk: false negatives; invariant: whitelist matches; strategy: allow.
      callback(null, true);
      return;
    }
    //audit assumption: origin not allowed; risk: blocked requests; invariant: reject unknown origins; strategy: error callback.
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: !allowAllOrigins
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Daemon GPT header parsing
app.use(createDaemonGptIdMiddleware({
  headerName: process.env.DAEMON_GPT_ID_HEADER,
  logger
}));

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  void res;
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    daemonGptId: req.daemonGptId
  });
  next();
});

const anonymousUserId = (process.env.AUTH_ANONYMOUS_USER_ID || 'anonymous').trim() || 'anonymous';
//audit assumption: API key config only needed in api_key mode; risk: unused config; invariant: config loaded conditionally; strategy: conditional load.
const apiKeyAuthConfig = authMode === 'api_key'
  ? loadApiKeyAuthConfig({ getEnvValue: (key) => process.env[key] })
  : null;
if (authMode === 'api_key' && (!apiKeyAuthConfig || !apiKeyAuthConfig.apiKey)) {
  //audit assumption: API key auth requires key; risk: insecure access; invariant: api key present; strategy: log and exit.
  logger.error('AUTH_API_KEY must be set when AUTH_MODE=api_key');
  process.exit(1);
}

// Routes
//audit assumption: auth router only needed for jwt mode; risk: unused route; invariant: router created conditionally; strategy: conditional creation.
const authRouter = authMode === 'jwt'
  ? createAuthRouter({
    getEnvValue: (key) => process.env[key],
    tokenSigner: generateToken,
    logger
  })
  : null;
const ipcRegistry = createIpcConnectionRegistry(logger);
const ipcConfig = loadIpcServerConfig();
const ipcServer = createIpcServer({
  httpServer: ipcHttpServer,
  config: ipcConfig,
  registry: ipcRegistry,
  logger,
  verifyToken,
  authMode,
  apiKey: apiKeyAuthConfig?.apiKey,
  apiKeyHeaderName: apiKeyAuthConfig?.headerName,
  apiKeyHeaderPrefix: apiKeyAuthConfig?.headerPrefix,
  apiKeyUserId: apiKeyAuthConfig?.userId,
  anonymousUserId,
  serverVersion: process.env.npm_package_version,
  daemonGptHeaderName: process.env.DAEMON_GPT_ID_HEADER,
  onEvent: async (event) => {
    //audit assumption: IPC events should be logged; risk: lost telemetry; invariant: audit event stored; strategy: write to database.
    await logAuditEvent(
      event.userId,
      event.eventType,
      {
        eventId: event.eventId,
        source: event.source,
        payload: event.payload,
        sentAt: event.sentAt,
        channel: 'ipc',
        daemonGptId: event.daemonGptId
      },
      event.ipAddress,
      event.userAgent
    );
  },
  onCommandResult: (result) => {
    //audit assumption: command results should be logged; risk: missing trace; invariant: log entry; strategy: log info.
    logger.info('IPC command result', {
      userId: result.userId,
      connectionId: result.connectionId,
      commandId: result.result.commandId,
      ok: result.result.ok
    });
  }
});

app.use('/api/health', healthRoute);
app.use('/healthcheck', healthRoute);
if (authMode === 'jwt' && authRouter) {
  //audit assumption: auth mode jwt enables login; risk: auth endpoints exposed; invariant: auth router mounted; strategy: mount when jwt.
  app.use('/api/auth', authRouter);
}
//audit assumption: auth middleware selection depends on auth mode; risk: unauthorized access; invariant: middleware chosen; strategy: conditional.
const authMiddleware = authMode === 'jwt'
  ? authenticateJWT
  : authMode === 'api_key'
    ? createApiKeyAuthMiddleware(apiKeyAuthConfig as NonNullable<typeof apiKeyAuthConfig>, logger)
    : attachAnonymousUser(anonymousUserId);
app.use('/api/ask', authMiddleware, askRoute);
app.use('/api/update', authMiddleware, updateRoute);
app.use('/api/audit', authMiddleware, auditRoute);
app.use('/api/arcanos-query', authMiddleware, arcanosQueryRoute);
app.use('/api/relay', authMiddleware, relayRoute);
app.use('/api/vision', authMiddleware, visionRoute);
app.use('/api/transcribe', authMiddleware, transcribeRoute);
app.use('/api/daemon', authMiddleware, createDaemonRouter(ipcRegistry, logger));

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  void req;
  //audit assumption: auth mode affects endpoint labels; risk: misleading docs; invariant: correct auth hint; strategy: set suffix by mode.
  const authSuffix = authMode === 'jwt'
    ? ', requires JWT'
    : authMode === 'api_key'
      ? ', requires API key'
      : '';
  res.json({
    name: 'ARCANOS Backend API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/api/health',
      ask: `/api/ask (POST${authSuffix})`,
      update: `/api/update (POST${authSuffix})`,
      audit: `/api/audit (GET${authSuffix})`,
      arcanosQuery: `/api/arcanos-query (POST${authSuffix})`,
      relay: `/api/relay (POST${authSuffix})`,
      vision: `/api/vision (POST${authSuffix})`,
      transcribe: `/api/transcribe (POST${authSuffix})`,
      daemon: `/api/daemon/command (POST${authSuffix})`
    }
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`
  });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  void next;
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
  });
});

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database
    const databaseReady = await initDatabase();
    if (databaseReady) {
      //audit assumption: database init success; risk: none; invariant: log ready; strategy: info log.
      logger.info('Database initialized');
    } else {
      //audit assumption: database init failed or disabled; risk: missing persistence; invariant: degraded mode; strategy: warn and continue.
      logger.warn('Database unavailable; running in degraded mode');
    }

    // Start listening
    httpServer.listen(PORT, () => {
      logger.info(`🚀 ARCANOS Backend running on port ${PORT}`);
      logger.info(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
    if (IPC_PORT !== PORT) {
      //audit assumption: IPC port differs from API port; risk: extra listener; invariant: IPC server started; strategy: start IPC listener.
      ipcHttpServer.listen(IPC_PORT, () => {
        logger.info(`IPC WebSocket server running on port ${IPC_PORT}`);
      });
    }
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Handle shutdown
let shutdownStarted = false;
const shutdown = async (signal: string) => {
  if (shutdownStarted) {
    //audit assumption: shutdown can be re-entrant; risk: double close; invariant: single shutdown path; strategy: guard with flag.
    return;
  }
  shutdownStarted = true;
  logger.info(`${signal} received, shutting down gracefully`);
  try {
    await ipcServer.close();
  } catch (error) {
    logger.warn('IPC server shutdown failed', { error });
  }
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  if (ipcHttpServer !== httpServer) {
    //audit assumption: IPC server may run on separate port; risk: dangling listener; invariant: IPC server closed; strategy: close IPC server.
    await new Promise<void>((resolve) => {
      ipcHttpServer.close(() => resolve());
    });
  }
  process.exit(0);
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

// Start server
startServer();

export default app;

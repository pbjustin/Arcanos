/**
 * Server Boot Messages and Route Descriptions
 * Centralized configuration for server startup logging
 */

export const SERVER_MESSAGES = {
  BOOT: {
    SERVER_RUNNING: '🚀 ARCANOS CORE',
    PORT_SWITCH: '🔀 ARCANOS PORT',
    ENVIRONMENT: '🌍 ARCANOS ENV',
    PROCESS_ID: '⚙️  ARCANOS PID',
    AI_MODEL: '🧠 ARCANOS AI',
    AI_FALLBACK: '🔄 ARCANOS AI',
    PORT_CHECK: '🔌 ARCANOS PORT',
    PORT_WARNING: '⚠️  ARCANOS PORT',
    GPT_SYNC_START: '🤖 GPT-SYNC',
    GPT_SYNC_ERROR: '❌ GPT-SYNC',
    BACKEND_SYNC: '🔄 BACKEND-SYNC',
    BACKEND_SYNC_ERROR: '❌ BACKEND-SYNC'
  },
  SUMMARY: {
    HEADER: '\n=== 🧠 ARCANOS BOOT SUMMARY ===',
    FOOTER: '===============================\n',
    OPERATIONAL: '✅ ARCANOS backend fully operational'
  },
  ROUTES: {
    TITLE: '🔧 Core Routes:',
    ASK: '   🔌 /ask - AI query endpoint',
    ARCANOS: '   🔌 /arcanos - Main AI interface',
    AI_ENDPOINTS: '   🔌 /ai-endpoints - AI processing endpoints',
    MEMORY: '   🔌 /memory - Memory management',
    WORKERS: '   🔌 /workers/* - Worker management',
    ORCHESTRATION: '   🔌 /orchestration/* - GPT-5.1 Orchestration Shell',
    SDK: '   🔌 /sdk/* - OpenAI SDK interface',
    STATUS: '   🔌 /status - System state (Backend Sync)',
    SIRI: '   🔌 /siri - Siri query endpoint',
    HEALTH: '   🔌 /health - System health'
  }
} as const;

export const SERVER_TEXT = {
  DIAGNOSTIC_START: 'Running system diagnostic...',
  DIAGNOSTIC_FAILURE_PREFIX: 'System diagnostic failed: ',
  PORT_CHECK_PROGRESS: 'Checking port availability...',
  PORT_CONFLICT_TIP: 'Consider stopping other services or setting a different PORT in .env',
  STATE_INIT_SUCCESS: 'System state initialized',
  STATE_INIT_FAILURE_PREFIX: 'Failed to initialize system state: '
} as const;

export const SERVER_CONSTANTS = {
  WORKERS_DIRECTORY: './workers',
  DIAGNOSTIC_DELAY_MS: 2000, // Delay before running system diagnostic
  SHUTDOWN_GRACE_PERIOD_MS: 5000, // Grace period for graceful shutdown
  DEFAULT_APP_VERSION: '1.0.0', // Default application version when npm version is unavailable
  LOG_PREVIEW_LENGTH: 100 // Default length for log message previews
} as const;

export const PORT_CONSTANTS = {
  DEFAULT_MAX_ATTEMPTS: 50,
  SEARCH_START_OFFSET: 1
} as const;

export const PORT_TEXT = {
  autoSelectedPort: (preferredPort: number, availablePort: number): string =>
    `Port ${preferredPort} was in use, automatically selected port ${availablePort}`,
  preferredPortInUse: (preferredPort: number): string =>
    `Port ${preferredPort} is already in use. Please stop the service using this port or set a different PORT in your environment.`,
  noAvailablePort: (startPort: number, endPort: number, attempts: number): string =>
    `No available port found in range ${startPort}-${endPort}. Tried ${attempts} ports. Please stop other services using these ports, use a different PORT in your environment, or increase the port search range.`
} as const;

export const HEARTBEAT_RESPONSE_TEMPLATE =
  'Heartbeat acknowledged. Mode: {mode}, write operations {writeStatus}, suppression level: {suppressionLevel}. Confirmation: {confirmation}.';

export const HEARTBEAT_LOG_FILENAME = 'heartbeat.log';

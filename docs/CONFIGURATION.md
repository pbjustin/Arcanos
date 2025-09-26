# ARCANOS Configuration Guide

Complete configuration reference for environment variables, deployment settings, and system parameters.

## ⚙️ Configuration

### Required Environment Variables
```bash
OPENAI_API_KEY=your-openai-api-key-here
AI_MODEL=your-fine-tuned-model-id-here  # Default: ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH
```

### Optional Database Configuration
```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/arcanos  # Optional - uses in-memory if not set
```

### Server Configuration
```bash
NODE_ENV=development           # Environment mode (development/production)
PORT=8080                      # Server port
DEFAULT_PORT=8080             # Default port for Railway deployment validation
ARC_LOG_PATH=/tmp/arc/log      # Directory for ARCANOS log files
ARC_MEMORY_PATH=/tmp/arc/memory # Directory for ARCANOS memory files
```

### Worker System
```bash
RUN_WORKERS=true              # Enable AI-controlled CRON jobs
WORKER_COUNT=4                # Number of worker processes
WORKER_MODEL=ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH  # Worker-specific model
WORKER_API_TIMEOUT_MS=60000   # API timeout for workers
WORKER_LOGIC=arcanos          # Worker logic implementation
SERVER_URL=http://localhost:8080  # Server URL for worker communication
```

### OpenAI Advanced Features
```bash
GPT5_MODEL=gpt-5              # GPT-5 model for advanced reasoning
BOOKER_TOKEN_LIMIT=512        # Token limit for booking prompts
TUTOR_DEFAULT_TOKEN_LIMIT=200 # Default token limit for tutor queries
```

### Notion Integration (Optional)
```bash
NOTION_API_KEY=your-notion-api-key-here        # Notion API key
WWE_DATABASE_ID=your-notion-wwe-database-id    # WWE database ID for roster sync
```

### Railway Deployment
```bash
RAILWAY_PROJECT=arcanos-core                   # Railway project name
RAILWAY_ENVIRONMENT=production                 # Railway environment
API_URL=https://your-app.railway.app          # Public API URL
MODEL_ROUTE=/query-finetune                    # Model API route
LOGIC_ROUTE=/ask                              # Logic API route
```

### GitHub Integration (Optional)
```bash
GITHUB_TOKEN=your-github-token-here           # GitHub API token
GITHUB_WEBHOOK_SECRET=your-webhook-secret     # Webhook secret
ENABLE_GITHUB_ACTIONS=true                    # Enable GitHub Actions
GITHUB_INTEGRATION=true                       # Enable GitHub features
ALLOW_WEBHOOKS=true                          # Allow webhook handling

# GitHub App Configuration (for Probot)
APP_ID=your-github-app-id-here               # GitHub App ID
PRIVATE_KEY_PATH=./private-key.pem           # Path to private key
# Alternative: PRIVATE_KEY=your-private-key-content-here
```

### Email Services (Optional)
```bash
EMAIL_SERVICE=smtp                           # Email service provider
EMAIL_HOST=smtp.sendgrid.net                # SMTP host
EMAIL_USER=apikey                           # SMTP username
EMAIL_PASS=your-smtp-password               # SMTP password/API key
EMAIL_FROM_NAME=Arcanos Backend             # From name

# Additional SMTP Settings
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=your-smtp-password
```

### Security & Admin
```bash
ADMIN_KEY=your-admin-key-here               # Admin API key
ALLOW_ROOT_OVERRIDE=true                    # Allow root override (dev only)
ROOT_OVERRIDE_TOKEN=supersecrettoken        # Root override token
ARCANOS_API_TOKEN=your-arcanos-api-token    # API token for memory endpoints
GPT_TOKEN=your-gpt-access-token             # GPT diagnostics token
```

### Advanced Features
```bash
DEPLOY_MODE=agent-control                   # Deployment mode
IDENTITY_OVERRIDE={"identity_override":{"name":"ARCANOS","version":"v2:BxRSDrhH"}}
IDENTITY_TRIGGER_PHRASE=I am Skynet        # Identity override trigger
MODEL_ID=gpt-3.5-turbo                     # Base model for fine-tuning
ENABLE_GPT_USER_HANDLER=true               # ChatGPT-style interaction
FALLBACK_WORKER=defaultWorker               # Fallback worker name

# Sleep Configuration (Low-Power Mode)
SLEEP_ENABLED=true
SLEEP_START=02:00
SLEEP_DURATION=7
SLEEP_TZ=UTC
```

### Development & Debugging
```bash
LOG_LEVEL=info                             # Logging level (error|warn|info|debug)
DEBUG=false                                # Enable debug mode
```

## Environment Variable Priority

ARCANOS supports multiple naming conventions for backward compatibility:

1. `AI_MODEL` (highest priority)
2. `FINE_TUNE_MODEL` 
3. `FINE_TUNED_MODEL`
4. `FINETUNED_MODEL_ID`

The system will use the first available value in this order.

## Validation

ARCANOS includes comprehensive environment validation on startup:
- Required variables are checked for presence
- Port numbers are validated for proper ranges
- Model IDs are validated for correct format
- File paths are checked for accessibility
- API keys are validated for proper format (when possible)

## Configuration Files

### `.env` File
Copy `.env.example` to `.env` and configure with your actual values:
```bash
cp .env.example .env
# Edit .env with your configuration
```

### TypeScript Configuration
The system reads environment variables at runtime and provides TypeScript type safety through the configuration system in `src/config/index.ts`.

## Railway-Specific Configuration

When deploying to Railway:
1. Set environment variables in the Railway dashboard
2. Railway will automatically set `PORT` - don't override it
3. Use `RAILWAY_ENVIRONMENT` to detect Railway deployment
4. Database URLs are automatically provided by Railway services

## Docker Configuration

For Docker deployments, all environment variables can be passed via:
- `-e` flags: `docker run -e OPENAI_API_KEY=your-key ...`
- `.env` file: `docker run --env-file .env ...`
- Docker Compose: Configure in `docker-compose.yml`
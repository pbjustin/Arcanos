# Configuration Reference

## Required Environment Variables
```bash
OPENAI_API_KEY=your-openai-api-key-here
AI_MODEL=your-fine-tuned-model-id-here  # Default: ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH
```

## Optional Database Configuration
```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/arcanos  # Optional - uses in-memory if not set
```

## Server Configuration
```bash
NODE_ENV=development            # Environment mode (development/production)
PORT=8080                       # Server port
ARC_LOG_PATH=/tmp/arc/log       # Directory for ARCANOS log files
ARC_MEMORY_PATH=/tmp/arc/memory # Directory for ARCANOS memory files
```

## Worker System Controls
```bash
RUN_WORKERS=true               # Enable AI-controlled background workers
WORKER_COUNT=4                 # Number of worker processes
WORKER_MODEL=your-model-id     # Worker-specific model (defaults to AI_MODEL)
WORKER_API_TIMEOUT_MS=60000    # Worker API timeout in milliseconds
```

## OpenAI Advanced Features
```bash
GPT51_MODEL=gpt-5.1            # Preferred GPT-5.1 model configuration
GPT5_MODEL=gpt-5               # Backwards compatible GPT-5.1 model configuration
BOOKER_TOKEN_LIMIT=512         # Token limit for backstage booking prompts
TUTOR_DEFAULT_TOKEN_LIMIT=200  # Default token limit for tutor queries
```

## Notion Integration (Optional)
```bash
NOTION_API_KEY=your-notion-api-key-here
WWE_DATABASE_ID=your-notion-wwe-database-id
```

## Railway Deployment
```bash
RAILWAY_PROJECT=arcanos-core
RAILWAY_ENVIRONMENT=production
API_URL=https://your-app.railway.app
```

## GitHub Integration (Optional)
```bash
GITHUB_TOKEN=your-github-token-here
GITHUB_WEBHOOK_SECRET=your-webhook-secret-here
ENABLE_GITHUB_ACTIONS=true
```

## Email Services (Optional)
```bash
EMAIL_SERVICE=smtp             # Choose: smtp, gmail, mailtrap, ethereal
EMAIL_HOST=smtp.sendgrid.net
EMAIL_USER=apikey
EMAIL_PASS=your-smtp-password-or-api-key
EMAIL_FROM_NAME=Arcanos Backend
```

## Security & Admin
```bash
ADMIN_KEY=your-admin-key-here
ALLOW_ROOT_OVERRIDE=true
ROOT_OVERRIDE_TOKEN=supersecrettoken
```

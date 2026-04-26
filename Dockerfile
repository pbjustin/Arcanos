# Optimized Railway Dockerfile
FROM node:20.18.1-alpine

# Set production environment
ENV NODE_ENV=production
ENV PYTHON=python3
ENV ARCANOS_WORKSPACE_ROOT=/app
ENV ARCANOS_PYTHON_RUNTIME_DIR=/app/daemon-python
ENV RAILWAY_CLI_BIN=/usr/local/lib/node_modules/@railway/cli/bin/railway

# Install build-time VCS dependency required by git-based npm overrides,
# OpenSSL for Prisma engine detection/runtime loading, and the minimal Python
# runtime needed for protocol repo tools.
RUN apk add --no-cache git openssl python3 py3-jsonschema

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S arcanos -u 1001

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
# Include package-lock.json so `npm ci` has a complete lockfile
COPY package*.json package-lock.json ./
COPY scripts/ ./scripts/
COPY prisma/ ./prisma/

# Install dependencies with memory optimization
RUN NODE_OPTIONS=--max_old_space_size=256 npm ci --omit=dev --no-audit --no-fund

# Install the Railway CLI binary required by the allowlisted control-plane adapter.
RUN npm install --global @railway/cli@4.30.2 --no-audit --no-fund

# Copy source code, workers, scripts, config, and build configuration
COPY src/ ./src/
COPY workers/ ./workers/
COPY packages/ ./packages/
COPY arcanos-ai-runtime/ ./arcanos-ai-runtime/
COPY daemon-python/ ./daemon-python/
COPY config/ ./config/
COPY contracts/ ./contracts/
COPY openapi/ ./openapi/
COPY tsconfig.json ./

# Install dev dependencies (override NODE_ENV) and build
RUN npm install --include=dev --no-audit --no-fund && \
    npx --yes prisma@5.22.0 generate --schema ./prisma/schema.prisma && \
    npm run build:workers && \
    npm run build

# Clean up dev dependencies after build
RUN npm prune --production

# Create runtime directories
RUN mkdir -p ./memory ./logs

# Change ownership to non-root user
RUN chown -R arcanos:nodejs /app
USER arcanos

# Expose Railway port
EXPOSE 8080

# Health check for Railway
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start through the Railway launcher so each Railway service enforces the
# explicit ARCANOS_PROCESS_KIND contract at runtime.
CMD ["node", "scripts/start-railway-service.mjs"]

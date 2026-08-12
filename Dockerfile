# Optimized Railway Dockerfile
FROM node:20.18.1-alpine

# Set production environment
ENV NODE_ENV=production
ENV PYTHON=python3
ENV ARCANOS_WORKSPACE_ROOT=/app
ENV ARCANOS_PYTHON_RUNTIME_DIR=/app/daemon-python
ENV RAILWAY_CLI_BIN=/usr/local/bin/railway-native

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
COPY vendor/ ./vendor/

# Install dependencies with memory optimization
RUN NODE_OPTIONS=--max_old_space_size=256 npm ci --omit=dev --no-audit --no-fund

# Install the Railway CLI binary required by the allowlisted control-plane
# adapter and the legacy self-improve loop. The npm package downloads this
# same release during postinstall without checksum verification or retries, so
# install the pinned native archive once and retain the bare `railway` command.
RUN set -eu; \
    railway_cli_archive=/tmp/railway-cli.tar.gz; \
    railway_cli_url=https://github.com/railwayapp/cli/releases/download/v4.30.2/railway-v4.30.2-x86_64-unknown-linux-musl.tar.gz; \
    railway_cli_sha256=7dd6633ced5c0ac579cbeb1842bc7e4bc14cfd2d43ea2e3a00b376320f80d1ce; \
    railway_cli_downloaded=false; \
    for attempt in 1 2 3 4 5; do \
      if wget -qO "${railway_cli_archive}" "${railway_cli_url}" && \
         printf '%s  %s\n' "${railway_cli_sha256}" "${railway_cli_archive}" | sha256sum -c -; then \
        railway_cli_downloaded=true; \
        break; \
      fi; \
      rm -f "${railway_cli_archive}"; \
      echo "Railway CLI download attempt ${attempt} failed." >&2; \
      if [ "${attempt}" -lt 5 ]; then sleep "$((attempt * 2))"; fi; \
    done; \
    test "${railway_cli_downloaded}" = true; \
    mkdir -p /tmp/railway-cli; \
    tar -xzf /tmp/railway-cli.tar.gz -C /tmp/railway-cli && \
    cp /tmp/railway-cli/railway /usr/local/bin/railway-native && \
    chmod 755 /usr/local/bin/railway-native && \
    ln -s /usr/local/bin/railway-native /usr/local/bin/railway && \
    rm -rf /tmp/railway-cli /tmp/railway-cli.tar.gz && \
    test "$(/usr/local/bin/railway-native --version)" = "railway 4.30.2" && \
    test "$(railway --version)" = "railway 4.30.2"

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
CMD ["node", "scripts/start-railway-service-with-integrity.mjs"]

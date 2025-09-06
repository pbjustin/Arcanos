# Optimized Railway Dockerfile
FROM node:20.11.1-alpine

# Set production environment
ENV NODE_ENV=production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S arcanos -u 1001

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies with memory optimization
RUN NODE_OPTIONS=--max_old_space_size=256 npm ci --only=production --no-audit --no-fund

# Copy source code and build configuration
COPY src/ ./src/
COPY tsconfig.json ./

# Install dev dependencies and build
RUN npm install --no-audit --no-fund && npm run build

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
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/api/test', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start with Railway-optimized memory settings
CMD ["sh", "-c", "NODE_OPTIONS='--max-old-space-size=7168' npm start"]
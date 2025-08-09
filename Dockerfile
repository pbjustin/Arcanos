# Multi-stage build for Railway BuildKit compatibility
# Build stage
FROM node:20.11.1-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files and .npmrc for dependency installation
COPY package*.json .npmrc ./

# Install production dependencies with capped memory
RUN NODE_OPTIONS=--max_old_space_size=256 npm install --omit=dev --no-audit --no-fund

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Copy everything and let npm build handle optional directories conditionally
COPY . ./

# Install dev dependencies if lockfile is present
RUN if [ -f package-lock.json ]; then \
      npm ci || npm install; \
    else \
      npm install; \
    fi

# Build the application
RUN npm run build

# Production stage
FROM node:20.11.1-alpine AS production

# Set production environment
ENV NODE_ENV=production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S arcanos -u 1001

# Set working directory
WORKDIR /app

# Copy package files and .npmrc
COPY package*.json .npmrc ./

# Install only production dependencies with capped memory
RUN NODE_OPTIONS=--max_old_space_size=256 npm install --omit=dev --no-audit --no-fund

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.railway ./.railway
COPY --from=builder /app/package.json ./package.json

# Create runtime directories that the application expects
RUN mkdir -p ./memory ./workers

# Change ownership to non-root user
RUN chown -R arcanos:nodejs /app
USER arcanos

# Expose the port (Railway default is 8080)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the application using npm start (which runs railway/workers.js)
# with optimized memory settings for 8GB Railway Hobby Plan
CMD ["sh", "-c", "NODE_OPTIONS='--max-old-space-size=7168' npm run start"]
# Multi-stage build for Railway BuildKit compatibility
# Build stage
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies with npm ci for reproducible builds
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY src/ ./src/
COPY sql/ ./sql/
COPY tsconfig.json ./

# Install dev dependencies for build
RUN npm ci

# Build the application
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Set production environment
ENV NODE_ENV=production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S arcanos -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/sql ./sql

# Change ownership to non-root user
RUN chown -R arcanos:nodejs /app
USER arcanos

# Expose the port (Railway default is 8080)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the application with optimized memory settings for 8GB Railway Hobby Plan
CMD ["node", "--max-old-space-size=7168", "dist/index.js"]
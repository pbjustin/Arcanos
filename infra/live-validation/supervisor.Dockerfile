# Trusted supervisor revision is independently pinned; PR code never runs in this service.
FROM node:24.18.1-alpine AS build
RUN test "$(node -p 'process.versions.node')" = "24.18.1" && test "$(npm --version)" = "11.16.0"
RUN apk add --no-cache git openssl python3 py3-jsonschema
ARG RAILWAY_GIT_COMMIT_SHA
RUN test "${#RAILWAY_GIT_COMMIT_SHA}" = 40 && \
    case "$RAILWAY_GIT_COMMIT_SHA" in *[!0-9a-f]*) exit 1 ;; esac && \
    git clone --no-checkout https://github.com/pbjustin/Arcanos.git /app && \
    git -C /app fetch origin "$RAILWAY_GIT_COMMIT_SHA" && \
    git -C /app checkout --detach "$RAILWAY_GIT_COMMIT_SHA" && \
    test "$(git -C /app rev-parse HEAD)" = "$RAILWAY_GIT_COMMIT_SHA"
WORKDIR /app
RUN CI=true npm ci --include=dev --no-audit --no-fund && npm run build && \
    mkdir -p /opt/validation && \
    node scripts/live-validation-build.mjs "$RAILWAY_GIT_COMMIT_SHA" supervisor /opt/validation/build.json && \
    rm -rf /app/.git

# Historical objects stay in the build stage and are absent from every final image layer.
FROM node:24.18.1-alpine
RUN test "$(node -p 'process.versions.node')" = "24.18.1" && test "$(npm --version)" = "11.16.0"
RUN apk add --no-cache openssl python3 py3-jsonschema
COPY --from=build --chown=root:root /app /app
COPY --from=build --chown=root:root /opt/validation/build.json /opt/validation/build.json
RUN test ! -e /app/.git && chmod -R a-w /app /opt/validation && \
    mkdir -p /run/arcanos-live-validation /var/lib/arcanos-live-validation && \
    chown node:node /run/arcanos-live-validation /var/lib/arcanos-live-validation && \
    chmod 700 /run/arcanos-live-validation /var/lib/arcanos-live-validation
ENV NODE_ENV=production TZ=UTC
# The fixed launcher initializes a fresh mounted ledger and immediately drops to uid 1000.
USER root
EXPOSE 8080 8443
CMD ["node", "/app/scripts/start-live-validation-supervisor.mjs"]

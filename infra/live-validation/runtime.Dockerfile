# Independent public Git checkout proves the build input; Railway metadata is verified separately.
FROM node:24.18.1-alpine
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
    node scripts/live-validation-build.mjs "$RAILWAY_GIT_COMMIT_SHA" runtime /opt/validation/build.json
RUN mkdir -p /run/arcanos-live-validation /run/arcanos-live-validation-empty && \
    chown node:node /run/arcanos-live-validation /run/arcanos-live-validation-empty && \
    chmod 700 /run/arcanos-live-validation /run/arcanos-live-validation-empty
ENV NODE_ENV=production TZ=UTC
USER node
WORKDIR /run/arcanos-live-validation-empty
EXPOSE 8080 8443
CMD ["node", "/app/scripts/start-live-validation-runtime.mjs"]

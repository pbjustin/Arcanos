# syntax=docker/dockerfile:1.7
# Railway V3-compatible validation image. Railway V3 rejects BuildKit secret mounts,
# so this path uses the public CA bundle only. Independent public Git checkout
# still proves the exact build input; Railway metadata is verified separately.
FROM node:24.18.1-alpine AS build
RUN test "$(node -p 'process.versions.node')" = "24.18.1" && test "$(npm --version)" = "11.16.0"
RUN apk add --no-cache git python3 py3-jsonschema
ARG RAILWAY_GIT_COMMIT_SHA
RUN test "${#RAILWAY_GIT_COMMIT_SHA}" = 40 && \
    case "$RAILWAY_GIT_COMMIT_SHA" in *[!0-9a-f]*) exit 1 ;; esac && \
    git init /app && \
    git -C /app remote add origin https://github.com/pbjustin/Arcanos.git && \
    git -C /app fetch --depth=1 --no-tags origin "$RAILWAY_GIT_COMMIT_SHA" && \
    git -C /app checkout --detach "$RAILWAY_GIT_COMMIT_SHA" && \
    test "$(git -C /app rev-parse HEAD)" = "$RAILWAY_GIT_COMMIT_SHA"
WORKDIR /app
RUN CI=true npm ci --include=dev --no-audit --no-fund && npm run build && \
    mkdir -p /opt/validation && \
    node scripts/live-validation-build.mjs "$RAILWAY_GIT_COMMIT_SHA" runtime /opt/validation/build.json && \
    rm -rf /app/.git

FROM node:24.18.1-alpine
RUN test "$(node -p 'process.versions.node')" = "24.18.1" && test "$(npm --version)" = "11.16.0"
RUN apk add --no-cache python3 py3-jsonschema
COPY --from=build --chown=root:root /app /app
COPY --from=build --chown=root:root /opt/validation/build.json /opt/validation/build.json
RUN test ! -e /app/.git && chmod -R a-w /app /opt/validation && \
    mkdir -p /run/arcanos-live-validation-empty && \
    chown node:node /run/arcanos-live-validation-empty && \
    chmod 700 /run/arcanos-live-validation-empty
ENV NODE_ENV=production TZ=UTC
USER node
WORKDIR /run/arcanos-live-validation-empty
EXPOSE 8080
CMD ["node", "/app/scripts/start-live-validation-runtime.mjs"]

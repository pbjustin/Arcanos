# syntax=docker/dockerfile:1.7
# Independent public Git checkout proves the build input; Railway metadata is verified separately.
FROM node:24.18.1-alpine AS build
RUN test "$(node -p 'process.versions.node')" = "24.18.1" && test "$(npm --version)" = "11.16.0"
RUN --mount=type=secret,id=proxy_ca \
    cp /etc/ssl/cert.pem /tmp/validation-public-ca.pem && \
    if test -f /run/secrets/proxy_ca; then cat /run/secrets/proxy_ca >> /etc/ssl/cert.pem; fi && \
    apk add --no-cache git python3 py3-jsonschema && \
    mv /tmp/validation-public-ca.pem /etc/ssl/cert.pem
ARG RAILWAY_GIT_COMMIT_SHA
RUN --mount=type=secret,id=proxy_ca \
    if test -f /run/secrets/proxy_ca; then export GIT_SSL_CAINFO=/run/secrets/proxy_ca; fi; \
    test "${#RAILWAY_GIT_COMMIT_SHA}" = 40 && \
    case "$RAILWAY_GIT_COMMIT_SHA" in *[!0-9a-f]*) exit 1 ;; esac && \
    git init /app && \
    git -C /app remote add origin https://github.com/pbjustin/Arcanos.git && \
    git -C /app fetch --depth=1 --no-tags origin "$RAILWAY_GIT_COMMIT_SHA" && \
    git -C /app checkout --detach "$RAILWAY_GIT_COMMIT_SHA" && \
    test "$(git -C /app rev-parse HEAD)" = "$RAILWAY_GIT_COMMIT_SHA"
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca \
    if test -f /run/secrets/proxy_ca; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    CI=true npm ci --include=dev --no-audit --no-fund && npm run build && \
    mkdir -p /opt/validation && \
    node scripts/live-validation-build.mjs "$RAILWAY_GIT_COMMIT_SHA" runtime /opt/validation/build.json && \
    rm -rf /app/.git

# Only the checked-out tree and its build proof enter the final image, never Git history layers.
FROM node:24.18.1-alpine
RUN test "$(node -p 'process.versions.node')" = "24.18.1" && test "$(npm --version)" = "11.16.0"
RUN --mount=type=secret,id=proxy_ca \
    cp /etc/ssl/cert.pem /tmp/validation-public-ca.pem && \
    if test -f /run/secrets/proxy_ca; then cat /run/secrets/proxy_ca >> /etc/ssl/cert.pem; fi && \
    apk add --no-cache python3 py3-jsonschema && \
    mv /tmp/validation-public-ca.pem /etc/ssl/cert.pem
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

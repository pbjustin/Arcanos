# Trusted scaffolding, independent from the candidate Dockerfile and scripts.
# Candidate install/build scripts have no registry, Railway or provider secret.
FROM node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS tooling
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/verification-tools
COPY tooling/ ./
# Trusted dependency install, scripts disabled; none of this stage reaches the
# runtime image. Candidate code cannot substitute its AST or graph tooling.
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --include=dev --ignore-scripts --no-audit --no-fund

FROM node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS build
RUN test "$(node -p 'process.versions.node')" = "24.18.1" && test "$(npm --version)" = "11.16.0"
RUN apt-get update && apt-get install -y --no-install-recommends git openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node candidate/ ./
USER node
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --include=dev --no-audit --no-fund && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
# Attest data in a fresh stage. Candidate scripts cannot replace this stage's
# interpreter, npm installation, PATH or trusted helper before it hashes bytes.
FROM node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS attest
COPY --from=tooling /opt/verification-tools /opt/verification-tools
WORKDIR /app
COPY candidate/ ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/workers/dist ./workers/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY --from=build /app/packages/arcanos-runtime/dist ./packages/arcanos-runtime/dist
COPY --from=build /app/packages/arcanos-openai/dist ./packages/arcanos-openai/dist
COPY build-tools.mjs /opt/stacked-preview/build-tools.mjs
COPY authorization.json /opt/stacked-preview/authorization.json
RUN rm -f /app/.npmrc && /usr/local/bin/node /opt/stacked-preview/build-tools.mjs compiled-manifest /opt/stacked-preview/authorization.json /opt/stacked-preview

FROM node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39
ARG CANDIDATE_SHA
ENV NODE_ENV=production
# Baked into the digest-bound image; never inferred from a moving Git branch.
ENV RAILWAY_GIT_COMMIT_SHA=${CANDIDATE_SHA}
WORKDIR /app
# Preserve pristine source; only compiled files and pruned dependencies come
# from the candidate build. No .git, build credentials or provider keys exist.
COPY --chown=node:node candidate/ ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/workers/dist ./workers/dist
COPY --from=build --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /app/packages/cli/dist ./packages/cli/dist
COPY --from=build --chown=node:node /app/packages/arcanos-runtime/dist ./packages/arcanos-runtime/dist
COPY --from=build --chown=node:node /app/packages/arcanos-openai/dist ./packages/arcanos-openai/dist
COPY --from=attest /opt/stacked-preview/compiled.json /opt/stacked-preview/compiled.json
COPY runtime.mjs /opt/stacked-preview/runtime.mjs
USER node
EXPOSE 8080
CMD ["node", "/opt/stacked-preview/runtime.mjs"]

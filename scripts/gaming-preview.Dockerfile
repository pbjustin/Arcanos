# Trusted fixed Gaming artifact profile. Candidate Dockerfiles never execute.
FROM node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS tooling
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY network.c /opt/gaming-preview/network.c
RUN gcc -O2 -Wall -Wextra -Werror -static -o /opt/gaming-preview/network-deny /opt/gaming-preview/network.c
WORKDIR /opt/verification-tools
COPY tooling/ ./
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --include=dev --ignore-scripts --no-audit --no-fund

# Only reviewed manifests, lock and local dependency bytes enter the online
# dependency fetch. No candidate scripts or candidate npm configuration do.
FROM node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS dependencies
RUN test "$(node -p 'process.versions.node')" = "24.18.1" && test "$(npm --version)" = "11.16.0"
RUN apt-get update && apt-get install -y --no-install-recommends git openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node candidate/package.json candidate/package-lock.json ./
COPY --chown=node:node candidate/packages/protocol/package.json ./packages/protocol/package.json
COPY --chown=node:node candidate/packages/cli/package.json ./packages/cli/package.json
COPY --chown=node:node candidate/packages/arcanos-runtime/package.json ./packages/arcanos-runtime/package.json
COPY --chown=node:node candidate/packages/arcanos-openai/package.json ./packages/arcanos-openai/package.json
COPY --chown=node:node candidate/workers/package.json ./workers/package.json
COPY --chown=node:node candidate/arcanos-ai-runtime/package.json ./arcanos-ai-runtime/package.json
COPY --chown=node:node candidate/vendor/minimatch-9.0.7/ ./vendor/minimatch-9.0.7/
USER node
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --include=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org

FROM dependencies AS build
COPY --chown=node:node candidate/ ./
# Candidate hooks, compilers and pruning cannot initiate any network traffic.
# These two audited initialization hooks match the existing exact-commit sandbox.
RUN --network=none CI=true node scripts/postinstall.cjs && \
    node node_modules/@prisma/client/scripts/postinstall.js && \
    npm run build && npm prune --offline --omit=dev --ignore-scripts --no-audit --no-fund

FROM scratch AS compiled
COPY --from=build /app/dist /compiled/dist
COPY --from=build /app/workers/dist /compiled/workers/dist
COPY --from=build /app/packages/protocol/dist /compiled/packages/protocol/dist
COPY --from=build /app/packages/cli/dist /compiled/packages/cli/dist
COPY --from=build /app/packages/arcanos-runtime/dist /compiled/packages/arcanos-runtime/dist
COPY --from=build /app/packages/arcanos-openai/dist /compiled/packages/arcanos-openai/dist

# Attest with a fresh interpreter and trusted graph dependencies. Candidate
# output cannot replace the checker interpreter, source or root-owned launcher.
FROM node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS attest
COPY --from=tooling /opt/verification-tools /opt/verification-tools
COPY --from=tooling /opt/gaming-preview /opt/gaming-preview
WORKDIR /app
COPY candidate/ ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=compiled /compiled/ ./
COPY build-tools.mjs /opt/gaming-preview/build-tools.mjs
COPY authorization.json /opt/gaming-preview/authorization.json
RUN --network=none rm -f /app/.npmrc && /usr/local/bin/node /opt/gaming-preview/build-tools.mjs compiled-manifest-gaming /opt/gaming-preview/authorization.json /opt/gaming-preview

FROM node:24.18.1-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39
ARG CANDIDATE_SHA
ENV NODE_ENV=production
ENV RAILWAY_GIT_COMMIT_SHA=${CANDIDATE_SHA}
WORKDIR /app
RUN install -d -o root -g root -m 0755 /opt/gaming-preview
COPY --chown=node:node candidate/ ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=compiled --chown=node:node /compiled/ ./
COPY --from=attest --chmod=0444 /opt/gaming-preview/compiled.json /opt/gaming-preview/compiled.json
COPY --from=tooling --chmod=0555 /opt/gaming-preview/network-deny /opt/gaming-preview/network-deny
COPY --chmod=0444 runtime.mjs /opt/gaming-preview/runtime.mjs
USER node
EXPOSE 8080
ENTRYPOINT ["/opt/gaming-preview/network-deny", "/usr/local/bin/node", "/opt/gaming-preview/runtime.mjs"]

# syntax=docker/dockerfile:1
ARG POSTGRES_MAJOR=18
FROM node:24.18.1-bookworm-slim AS node
FROM postgres:${POSTGRES_MAJOR}-bookworm

# Session trust is mounted only for dependency acquisition and is never retained.
RUN --mount=type=secret,id=system_ca,required=true --mount=type=secret,id=proxy_ca \
    set -eu; \
    cat /run/secrets/system_ca > /tmp/inspection-build-ca.pem; \
    if [ -f /run/secrets/proxy_ca ]; then cat /run/secrets/proxy_ca >> /tmp/inspection-build-ca.pem; fi; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::https::CaInfo=/tmp/inspection-build-ca.pem \
      -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true update; \
    apt-get -o Acquire::https::CaInfo=/tmp/inspection-build-ca.pem \
      -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true \
      install -y --no-install-recommends ca-certificates git openssl libstdc++6; \
    rm -rf /var/lib/apt/lists/* /tmp/inspection-build-ca.pem

COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY . /app
RUN test "$(node --version)" = 'v24.18.1'
ENTRYPOINT ["node", "tests/fixtures/railway-production-inspection/run-fixtures.mjs"]

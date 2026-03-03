"""
v2 Trust Verification — Configuration

Required env vars:
    REDIS_URL       — Redis connection string
    JWKS_URL        — JWKS endpoint for EdDSA public keys
    V2_TRUST_ISSUER — (optional) override token issuer
"""

import os


class V2Config:
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    JWKS_URL: str = os.getenv("JWKS_URL", "")
    EXPECTED_ISSUER: str = os.getenv("V2_TRUST_ISSUER", "arcanos-trust-authority")
    ALLOWED_ALG: str = "EdDSA"
    CLOCK_SKEW_SECONDS: int = 5
    NONCE_PREFIX: str = "nonce:"
    LOCK_PREFIX: str = "lock:"

    # Circuit breaker
    CB_FAILURE_THRESHOLD: int = 5
    CB_RESET_TIMEOUT_SEC: float = 30.0
    CB_HALF_OPEN_MAX_CALLS: int = 1

    # Lock defaults
    LOCK_TTL_SEC: int = 5
    LOCK_HEARTBEAT_SEC: float = 2.0

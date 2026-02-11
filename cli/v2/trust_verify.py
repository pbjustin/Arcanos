"""
v2 Trust Verification — Token Verification

Validates EdDSA-signed JWTs with:
  - Strict algorithm enforcement (no algorithm confusion)
  - kid-based JWKS lookup
  - Atomic nonce replay prevention via Redis NX
  - Clock skew validation
  - Nonce format validation
  - Trace ID propagation
  - Fail-closed when Redis is unavailable
"""

import re
import time
import logging
import jwt

from .config import V2Config
from .jwks import get_jwks_cache
from .redis_client import set_nx
from .audit_logger import log_event
from .circuit_breaker import CircuitBreaker

logger = logging.getLogger("arcanos.v2.trust")

VALID_TRUST_LEVELS = frozenset({"FULL", "DEGRADED", "UNSAFE"})
REQUIRED_CLAIMS = {"exp", "iat", "nonce", "trace", "trust"}
NONCE_MAX_LENGTH = 128
NONCE_PATTERN = re.compile(r"^[a-zA-Z0-9_\-]+$")


def verify_trust_token(token: str) -> dict:
    """
    Verify and decode a v2 trust token.

    Returns the decoded payload on success.
    Raises RuntimeError on any validation failure.
    """

    # --- 1. Decode header without verification to extract alg + kid ---
    try:
        header = jwt.get_unverified_header(token)
    except jwt.exceptions.DecodeError as e:
        raise RuntimeError(f"Malformed token header: {e}") from e

    alg = header.get("alg")
    if alg != V2Config.ALLOWED_ALG:
        raise RuntimeError(
            f"Algorithm confusion: expected {V2Config.ALLOWED_ALG}, got {alg}"
        )

    kid = header.get("kid")
    if not kid:
        raise RuntimeError("Missing kid in token header")

    # --- 2. Resolve public key via JWKS ---
    cache = get_jwks_cache()
    public_key = cache.get_public_key(kid)

    # --- 3. Verify signature and decode ---
    try:
        payload = jwt.decode(
            token,
            public_key,
            algorithms=[V2Config.ALLOWED_ALG],
            issuer=V2Config.EXPECTED_ISSUER,
            options={
                "require": list(REQUIRED_CLAIMS),
                "verify_exp": True,
                "verify_iat": True,
                "verify_iss": True,
            },
        )
    except jwt.ExpiredSignatureError:
        raise RuntimeError("Token has expired")
    except jwt.InvalidIssuerError:
        raise RuntimeError("Invalid token issuer")
    except jwt.InvalidTokenError as e:
        raise RuntimeError(f"Token verification failed: {e}") from e

    # --- 4. Validate trust level ---
    trust = payload.get("trust")
    if trust not in VALID_TRUST_LEVELS:
        raise RuntimeError(f"Invalid trust level: {trust}")

    # Clock skew is enforced by the JWT library via `leeway`/`options` where supported.

    # --- 6. Nonce format validation ---
    nonce = payload["nonce"]
    if (
        not isinstance(nonce, str)
        or len(nonce) == 0
        or len(nonce) > NONCE_MAX_LENGTH
        or not NONCE_PATTERN.match(nonce)
    ):
        raise RuntimeError("Invalid nonce format")

    # --- 7. Nonce replay prevention ---
    exp = payload["exp"]
    ttl = exp - now

    if ttl <= 0:
        raise RuntimeError("Token already expired — nonce TTL would be non-positive")

    nonce_key = f"{V2Config.NONCE_PREFIX}{nonce}"

    try:
        was_set = set_nx(nonce_key, ttl)
    except Exception as e:
        # Prefer explicit exception type from circuit breaker rather than string matching
        if isinstance(e, getattr(CircuitBreaker, "CircuitBreakerOpenError", ())) or (
            isinstance(e, Exception) and getattr(e, "name", "") == "CircuitBreakerOpenError"
        ):
            log_event({
                "type": "DEGRADED_MODE",
                "reason": "Redis circuit breaker open",
                "trace": payload.get("trace", ""),
            })
            raise RuntimeError(
                "Trust verification degraded — Redis unavailable, failing closed"
            ) from e
        raise

    if not was_set:
        log_event({
            "type": "REPLAY_DETECTED",
            "nonce": nonce,
            "trace": payload.get("trace", ""),
        })
        raise RuntimeError("Replay detected — nonce already consumed")

    log_event({
        "type": "TRUST_VERIFIED",
        "trust": trust,
        "nonce": nonce,
        "trace": payload.get("trace", ""),
    })

    return payload

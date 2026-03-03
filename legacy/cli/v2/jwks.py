"""
v2 Trust Verification — JWKS Key Resolution

Caches JWKS keys by kid, with automatic refresh on cache miss.
Enforces HTTPS for JWKS URL and validates Ed25519 key curve.

REQUIRES: pip install PyJWT[crypto] requests cryptography
"""

import time
import logging
import threading
import requests
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
import jwt

from .config import V2Config

logger = logging.getLogger("arcanos.v2.jwks")

_CACHE_MAX_AGE_SEC = 60
_COOLDOWN_SEC = 30


class JWKSCache:
    def __init__(self, url: str | None = None):
        self._url = url or V2Config.JWKS_URL
        self._keys: dict[str, dict] = {}
        self._last_fetch: float = 0.0
        self._lock = threading.Lock()

        # Enforce HTTPS
        if self._url and not self._url.startswith("https://"):
            raise RuntimeError(
                f"JWKS URL must use HTTPS (got: {self._url})"
            )

    def _should_refresh(self) -> bool:
        with self._lock:
            return time.monotonic() - self._last_fetch > _CACHE_MAX_AGE_SEC

    def refresh(self) -> None:
        """Fetch JWKS from the remote endpoint."""
        if not self._url:
            raise RuntimeError("JWKS_URL is not configured")

        with self._lock:
            # Cooldown: don't hammer the JWKS endpoint
            if time.monotonic() - self._last_fetch < _COOLDOWN_SEC:
                return

        # Fetch outside the lock to avoid blocking other threads
        response = requests.get(self._url, timeout=5)
        response.raise_for_status()
        jwks = response.json()

        if "keys" not in jwks or not isinstance(jwks["keys"], list):
            raise RuntimeError("Invalid JWKS response — missing 'keys' array")

        new_keys: dict[str, dict] = {}
        for k in jwks["keys"]:
            kid = k.get("kid")
            if kid:
                new_keys[kid] = k

        with self._lock:
            self._keys = new_keys
            self._last_fetch = time.monotonic()
            logger.info("JWKS refreshed — %d keys loaded", len(self._keys))

    def get_public_key(self, kid: str) -> Ed25519PublicKey:
        """
        Resolve a kid to an Ed25519 public key.
        Auto-refreshes cache on miss.
        """
        with self._lock:
            needs_refresh = kid not in self._keys
        if needs_refresh or self._should_refresh():
            self.refresh()

        with self._lock:
            jwk_data = self._keys.get(kid)
        if not jwk_data:
            raise RuntimeError(f"kid not found in JWKS: {kid}")

        # Validate curve before deserializing
        crv = jwk_data.get("crv")
        if crv != "Ed25519":
            raise RuntimeError(
                f"Expected Ed25519 key for kid={kid}, got crv={crv}"
            )

        key = jwt.algorithms.OKPAlgorithm.from_jwk(jwk_data)
        if not isinstance(key, Ed25519PublicKey):
            raise RuntimeError(f"Key for kid={kid} is not Ed25519PublicKey")

        return key


# Module-level singleton with thread-safe init
_cache: JWKSCache | None = None
_cache_lock = threading.Lock()


def get_jwks_cache() -> JWKSCache:
    global _cache
    if _cache is None:
        with _cache_lock:
            if _cache is None:
                _cache = JWKSCache()
    return _cache

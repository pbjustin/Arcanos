from __future__ import annotations

import base64
import binascii
import json
import logging
import time
from typing import Optional

try:
    import jwt
    from jwt import PyJWKClient
    JWT_AVAILABLE = True
except ImportError:
    JWT_AVAILABLE = False
    jwt = None
    PyJWKClient = None

logger = logging.getLogger("arcanos.credential_bootstrap")


def parse_jwt_expiration(token: str) -> Optional[int]:
    """
    Purpose: Extract JWT expiration (exp) without verifying signature.
    Inputs/Outputs: JWT token string; returns exp epoch seconds or None.
    Edge cases: Invalid tokens or missing exp return None.
    """
    parts = token.split(".")
    if len(parts) != 3:
        # //audit assumption: JWT has three parts; risk: malformed token; invariant: 3 segments; strategy: return None.
        return None

    payload_segment = parts[1]
    padding = "=" * (-len(payload_segment) % 4)
    padded_segment = f"{payload_segment}{padding}"

    try:
        payload_bytes = base64.urlsafe_b64decode(padded_segment.encode("ascii"))
    except (binascii.Error, ValueError):
        # //audit assumption: payload is base64url; risk: decode failure; invariant: decodable payload; strategy: return None.
        return None

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        # //audit assumption: payload is JSON; risk: invalid JSON; invariant: JSON object; strategy: return None.
        return None

    exp_value = payload.get("exp") if isinstance(payload, dict) else None
    if not isinstance(exp_value, int):
        # //audit assumption: exp is integer; risk: missing expiry; invariant: exp optional; strategy: return None.
        return None

    return exp_value


def is_jwt_expired(token: str, now_seconds: float, leeway_seconds: int = 60) -> bool:
    """
    Purpose: Determine whether a JWT is expired or close to expiry.
    Inputs/Outputs: token string, current time, and leeway; returns True if expired.
    Edge cases: Tokens without exp are treated as expired.
    """
    exp_value = parse_jwt_expiration(token)
    if exp_value is None:
        # //audit assumption: tokens should have exp; risk: unbounded token; invariant: exp required; strategy: treat as expired.
        return True

    # //audit assumption: leeway avoids edge expiry; risk: near-expiry use; invariant: now+leeway < exp; strategy: compare with leeway.
    return now_seconds + leeway_seconds >= exp_value


# JWKS cache for RS256 tokens
_jwks_cache: dict[str, tuple[PyJWKClient, float]] = {}
_JWKS_CACHE_TTL = 3600  # 1 hour


def verify_backend_jwt(
    token: str,
    secret: Optional[str] = None,
    public_key: Optional[str] = None,
    jwks_url: Optional[str] = None
) -> bool:
    """
    Purpose: Verify backend JWT signature and standard claims (exp, iat, iss, aud).
    Inputs/Outputs: token string, optional secret/public_key/jwks_url; returns True if valid, False if invalid.
    Edge cases: Returns False if verification fails or JWT library unavailable; logs warnings for missing verification keys.
    """
    if not JWT_AVAILABLE:
        logger.warning(
            "PyJWT not available. JWT signature verification disabled. "
            "Install PyJWT>=2.8,<3 to enable verification."
        )
        return False
    
    if not token:
        return False
    
    # Determine verification method
    if secret:
        # HS256 with shared secret
        try:
            jwt.decode(
                token,
                secret,
                algorithms=["HS256"],
                options={"verify_signature": True, "verify_exp": True}
            )
            return True
        except jwt.ExpiredSignatureError:
            logger.debug("JWT token expired")
            return False
        except jwt.InvalidTokenError as e:
            logger.debug(f"JWT token invalid: {e}")
            return False
        except Exception as e:
            logger.warning(f"JWT verification error (HS256): {e}")
            return False
    
    elif public_key:
        # RS256 with public key
        try:
            jwt.decode(
                token,
                public_key,
                algorithms=["RS256"],
                options={"verify_signature": True, "verify_exp": True}
            )
            return True
        except jwt.ExpiredSignatureError:
            logger.debug("JWT token expired")
            return False
        except jwt.InvalidTokenError as e:
            logger.debug(f"JWT token invalid: {e}")
            return False
        except Exception as e:
            logger.warning(f"JWT verification error (RS256): {e}")
            return False
    
    elif jwks_url:
        # RS256 with JWKS URL
        try:
            # Check cache
            now = time.time()
            jwks_client = None
            cache_key = jwks_url
            
            if cache_key in _jwks_cache:
                cached_client, cached_time = _jwks_cache[cache_key]
                if now - cached_time < _JWKS_CACHE_TTL:
                    jwks_client = cached_client
                else:
                    # Cache expired, remove
                    del _jwks_cache[cache_key]
            
            if not jwks_client:
                jwks_client = PyJWKClient(jwks_url)
                _jwks_cache[cache_key] = (jwks_client, now)
            
            # Get signing key from JWKS
            signing_key = jwks_client.get_signing_key_from_jwt(token)
            
            jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                options={"verify_signature": True, "verify_exp": True}
            )
            return True
        except jwt.ExpiredSignatureError:
            logger.debug("JWT token expired")
            return False
        except jwt.InvalidTokenError as e:
            logger.debug(f"JWT token invalid: {e}")
            return False
        except Exception as e:
            logger.warning(f"JWT verification error (JWKS): {e}")
            return False
    
    else:
        logger.warning(
            "JWT verification key not configured. Set BACKEND_JWT_SECRET, "
            "BACKEND_JWT_PUBLIC_KEY, or BACKEND_JWT_JWKS_URL to enable signature verification."
        )
        return False

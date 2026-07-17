"""Dependency-light verification for opaque credential values."""

from __future__ import annotations

import hashlib
import hmac


def timing_safe_equal_opaque_secret(provided: object, expected: object) -> bool:
    """
    Compare two opaque string credentials without parsing or normalization.

    Non-string or empty values are rejected. UTF-32LE digests give
    ``compare_digest`` fixed-length inputs while preserving exact,
    case-sensitive string equality, including lone surrogate code units.
    """
    if not isinstance(provided, str) or not isinstance(expected, str):
        return False
    if not provided or not expected:
        return False

    provided_digest = hashlib.sha256(
        provided.encode("utf-32le", errors="surrogatepass")
    ).digest()
    expected_digest = hashlib.sha256(
        expected.encode("utf-32le", errors="surrogatepass")
    ).digest()
    return hmac.compare_digest(provided_digest, expected_digest)


__all__ = ["timing_safe_equal_opaque_secret"]

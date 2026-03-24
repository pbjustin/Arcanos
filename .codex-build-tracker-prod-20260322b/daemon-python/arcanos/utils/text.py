"""Text normalization utilities shared across ARCANOS modules."""

from __future__ import annotations


def sanitize_utf8_text(value: str) -> str:
    """
    Purpose: Normalize arbitrary strings into UTF-8 encodable text.
    Inputs/Outputs: raw text -> UTF-8-safe text.
    Edge cases: Replaces lone surrogate code points that cannot be encoded.
    """
    # //audit assumption: callers may pass malformed Unicode from external systems; risk: serialization crashes on lone surrogates; invariant: returned string always encodes with UTF-8; handling strategy: replace invalid code points during encode/decode normalization.
    return value.encode("utf-8", errors="replace").decode("utf-8")


__all__ = ["sanitize_utf8_text"]

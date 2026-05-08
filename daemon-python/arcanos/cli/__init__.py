"""
Public exports for modular ARCANOS CLI package.
"""

__all__ = ["ArcanosCLI", "main"]


def __getattr__(name: str):
    if name in __all__:
        from .cli import ArcanosCLI, main

        return {"ArcanosCLI": ArcanosCLI, "main": main}[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

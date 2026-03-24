"""ARCANOS package entry."""

__all__ = ["__version__", "ArcanosCLI", "main"]
__version__ = "1.1.2"


def __getattr__(name: str):
    """Lazy import ArcanosCLI and main to avoid RuntimeWarning when running as python -m arcanos.cli."""
    if name == "ArcanosCLI":
        from .cli import ArcanosCLI
        return ArcanosCLI
    if name == "main":
        from .cli import main
        return main
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

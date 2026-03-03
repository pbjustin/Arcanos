from enum import Enum, auto


class TrustState(Enum):
    FULL = auto()
    DEGRADED = auto()
    UNSAFE = auto()

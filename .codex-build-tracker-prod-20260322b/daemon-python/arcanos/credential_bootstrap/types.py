from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


class CredentialBootstrapError(RuntimeError):
    """
    Purpose: Structured error for credential bootstrap failures.
    Inputs/Outputs: Message describing the bootstrap failure reason.
    Edge cases: Wraps env file or backend auth errors for display.
    """


@dataclass(frozen=True)
class CredentialBootstrapResult:
    """
    Purpose: Result of credential bootstrap for runtime updates.
    Inputs/Outputs: OpenAI key, backend token, and backend login email.
    Edge cases: backend_token and backend_login_email may be None if backend is unused.
    """

    openai_api_key: str
    backend_token: Optional[str]
    backend_login_email: Optional[str]

import aiohttp
from typing import Any, Tuple


class HTTPClient:
    """Asynchronous HTTP client for backend-service communication."""

    def __init__(self, base_url: str, api_key: str):
        """
        Create a backend HTTP client.
        Inputs: backend base URL and bearer API key.
        Outputs: initialized client with lazy session lifecycle.
        Edge case behavior: the session is recreated automatically if previously closed.
        """
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._session: aiohttp.ClientSession | None = None

    def _headers(self) -> dict[str, str]:
        """Build request headers for authenticated JSON requests."""
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

    async def _get_or_create_session(self) -> aiohttp.ClientSession:
        """
        Get a reusable aiohttp session.
        Inputs: none.
        Outputs: active ClientSession.
        Edge case behavior: creates a new session if none exists or the old one is closed.
        """
        # //audit assumption: session reuse improves connection pooling and reduces per-request overhead.
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        """
        Close the underlying session if open.
        Inputs: none.
        Outputs: none.
        Edge case behavior: no-op if no session exists.
        """
        # //audit strategy: explicit close prevents connector/resource leaks in long-running agents.
        if self._session is not None and not self._session.closed:
            await self._session.close()

    async def __aenter__(self) -> "HTTPClient":
        await self._get_or_create_session()
        return self

    async def __aexit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        await self.close()

    async def post(self, endpoint: str, payload: dict[str, Any]) -> Tuple[int, Any]:
        """
        Send a POST request to the backend.
        Inputs: endpoint path and JSON payload.
        Outputs: tuple of (HTTP status code, parsed response payload).
        Edge case behavior: falls back to response text when the body is not valid JSON.
        """
        session = await self._get_or_create_session()
        async with session.post(
            f"{self.base_url}{endpoint}",
            json=payload,
            headers=self._headers()
        ) as response:
            try:
                return response.status, await response.json()
            except aiohttp.ContentTypeError:
                # //audit handling: tolerate non-JSON error payloads without masking response status.
                return response.status, {"raw": await response.text()}

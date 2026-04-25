import json

import requests
from .contracts import AnalysisRequest, RawBackendResponse


class BackendClient:

    EXPECTED_CONTRACT_VERSION = "1.0.0"

    def __init__(self, runtime):
        self.runtime = runtime
        self.base_url = runtime.backend_url

    @staticmethod
    def _parse_response_body(response):
        text = response.text
        if not text:
            return None

        try:
            return response.json()
        except ValueError:
            return text

    @staticmethod
    def _format_body_for_message(body):
        if body is None:
            return "<empty response body>"
        if isinstance(body, str):
            return body
        try:
            return json.dumps(body, separators=(",", ":"))
        except TypeError:
            return str(body)

    def _degraded_response(self, message: str, *, status=None, url=None, body=None):
        self.runtime.mode = "DEGRADED"
        meta = {
            "status": status,
            "url": url,
            "body": body,
        }

        return RawBackendResponse(
            result=message,
            contract_version=self.EXPECTED_CONTRACT_VERSION,
            meta={key: value for key, value in meta.items() if value is not None},
        )

    def analyze(self, context_payload: dict, artifacts: list):
        """
        Purpose: Send an analysis request to the backend and parse the contract response.
        Inputs/Outputs: context payload + artifacts; returns RawBackendResponse.
        Edge cases: Network or HTTP failures force DEGRADED mode with fallback response.
        """
        request = AnalysisRequest(
            runtime_version=self.runtime.runtime_version,
            schema_version=self.runtime.schema_version,
            trace_id=self.runtime.trace_id,
            context=context_payload,
            artifacts=artifacts,
        )

        try:
            response = requests.post(
                f"{self.base_url}/gpt/arcanos-daemon",
                json={
                    "action": "query",
                    "prompt": (
                        "Analyze the following runtime payload and return the standard backend response. "
                        f"Request: {request.model_dump_json()}"
                    ),
                    "metadata": request.model_dump(),
                },
                timeout=60,
            )

            body = self._parse_response_body(response)
            if response.status_code >= 400:
                formatted_body = self._format_body_for_message(body)
                message = (
                    f"Backend request failed with HTTP {response.status_code}: "
                    f"{formatted_body}"
                )
                print(
                    f"[ERROR][{self.runtime.trace_id}] {message}; entering DEGRADED mode"
                )
                return self._degraded_response(
                    message,
                    status=response.status_code,
                    url=response.url,
                    body=body,
                )

            if not isinstance(body, dict):
                message = (
                    "Backend request returned a non-JSON or non-object JSON response: "
                    f"{self._format_body_for_message(body)}"
                )
                print(
                    f"[ERROR][{self.runtime.trace_id}] {message}; entering DEGRADED mode"
                )
                return self._degraded_response(
                    message,
                    status=response.status_code,
                    url=response.url,
                    body=body,
                )

            parsed = RawBackendResponse(**body)

            if (
                parsed.contract_version
                and parsed.contract_version != self.EXPECTED_CONTRACT_VERSION
            ):
                print(
                    f"[WARNING] Contract mismatch. "
                    f"Expected {self.EXPECTED_CONTRACT_VERSION}, "
                    f"got {parsed.contract_version}"
                )

            return parsed

        except requests.RequestException as error:
            # //audit Assumption: backend outages are expected in hybrid mode; risk: silent degradation hides root cause; invariant: failure reason is surfaced; handling: log + fallback response.
            print(
                f"[ERROR][{self.runtime.trace_id}] Backend request failed, entering DEGRADED mode: {error}"
            )
            return self._degraded_response(
                "? Backend unavailable. Running in DEGRADED mode."
            )

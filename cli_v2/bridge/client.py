import requests
from .contracts import AnalysisRequest, RawBackendResponse


class BackendClient:

    EXPECTED_CONTRACT_VERSION = "1.0.0"

    def __init__(self, runtime):
        self.runtime = runtime
        self.base_url = runtime.backend_url

    def analyze(self, context_payload: dict, artifacts: list):
        request = AnalysisRequest(
            runtime_version=self.runtime.runtime_version,
            schema_version=self.runtime.schema_version,
            trace_id=self.runtime.trace_id,
            context=context_payload,
            artifacts=artifacts,
        )

        try:
            response = requests.post(
                f"{self.base_url}/ask",
                json=request.model_dump(),
                timeout=60,
            )

            response.raise_for_status()
            parsed = RawBackendResponse(**response.json())

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

        except requests.RequestException:
            self.runtime.mode = "DEGRADED"

            return RawBackendResponse(
                result="? Backend unavailable. Running in DEGRADED mode.",
                contract_version=self.EXPECTED_CONTRACT_VERSION,
            )

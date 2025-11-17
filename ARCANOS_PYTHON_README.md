# 🐍 Arcanos Python Companion Module

The Arcanos backend exposes a fine-tuned GPT-5.1 workflow to Python workloads via
`python-client/`. The module mirrors the confirmation + failover guarantees of
the Node.js server while giving research notebooks and automation scripts a
minimal API for reasoning. Every invocation enforces the fine-tuned model,
propagates metadata for auditing, and notifies the maintenance assistant on any
failure so the broader system stays aware of degraded states.

## 📦 Repository Layout

```
python-client/
├── arcanos_client/
│   ├── __init__.py         # Package exports
│   ├── client.py           # Reasoning helper enforcing GPT-5.1 usage
│   └── notifier.py         # Maintenance assistant webhook integration
├── example.py              # Quick smoke-test script
└── requirements.txt        # Python dependency pin (OpenAI SDK)
```

Add the `python-client/` directory to your `PYTHONPATH` (or install it with
`pip install -e python-client`) before importing `arcanos_client`.

## 🚀 Quick Start

1. **Create a virtual environment** (recommended):
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```
2. **Install dependencies**:
   ```bash
   pip install -r python-client/requirements.txt
   ```
3. **Export required environment variables**:
   - `OPENAI_API_KEY`: API key used by `openai.OpenAI`.
   - `ARCANOS_FINE_TUNED_MODEL`: GPT-5.1 fine-tuned model identifier.
   - Optional: `ARCANOS_MAINTENANCE_WEBHOOK` for failure notifications.
4. **Run the sample script**:
   ```bash
   python python-client/example.py
   ```

The script performs a single-shot prompt with `ArcanosPythonClient` and prints
the response or the failure reason if the maintenance notifier is triggered.

## 🧠 Using `ArcanosPythonClient`

```python
from arcanos_client import ArcanosPythonClient

client = ArcanosPythonClient()
response = client.run_reasoning([
    {"role": "system", "content": "You are the Arcanos maintenance AI."},
    {"role": "user", "content": "List the current confirmation layers."},
])
print(response["content"])
```

Key behaviors:

- **Strict model enforcement** – The class fails fast if `ARCANOS_FINE_TUNED_MODEL`
  is absent, ensuring GPT-5.1 reasoning never silently falls back.
- **Maintenance notifications** – Every exception funnels through
  `MaintenanceNotifier`, which posts the failure payload to
  `ARCANOS_MAINTENANCE_WEBHOOK` (or logs locally when unset).
- **Metadata passthrough** – `run_reasoning(..., metadata={...})` adds audit
  metadata to the OpenAI request, mirroring the backend logging strategy.
- **Single prompt helper** – `run_simple_prompt(text)` is available for CLI tools
  that only need a single user turn.

## ⚙️ Configuration Matrix

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | ✅ | Secret passed to the OpenAI SDK. Mirrors the backend default. |
| `ARCANOS_FINE_TUNED_MODEL` | ✅ | Fine-tuned GPT-5.1 model ID authorized for this repo. |
| `ARCANOS_MAINTENANCE_WEBHOOK` | ⚪️ | Optional HTTPS endpoint that receives JSON incidents. |
| `ARCANOS_CONFIRMATION_TOKEN` | ⚪️ | Token you can include inside `metadata` for cross-system audits. |

## 🛡️ Failure Flow

1. `ArcanosPythonClient` builds the OpenAI client and validates the configured
   model.
2. Any exception raised by `openai` triggers `MaintenanceNotifier.notify(...)`.
3. The notifier posts a JSON payload to `ARCANOS_MAINTENANCE_WEBHOOK` with the
   failure reason and incident class.
4. The original exception is re-raised so the calling automation can decide
   whether to retry or escalate.

When the webhook is not configured the notifier logs to STDOUT, which keeps local
experiments lightweight while still surfacing the degradation signal.

## 🧪 Testing & Linting

- Run `python -m compileall python-client` to ensure the package parses.
- Execute unit or integration tests from your preferred harness. The module is
  intentionally dependency-light so you can drop it into pytest, notebooks, or
  ad-hoc scripts.

## 🔗 Integrating With The Node.js Backend

- Include a `metadata` field when calling `run_reasoning` that mirrors the
  confirmation token or system intent used on the Express server. This makes it
  trivial to correlate Python-issued reasoning with `/logs` and `/status`.
- When running inside the same container as the backend, point both processes to
  the same `.env` so model + API key drift cannot occur.
- Use the webhook notifier to alert an on-call assistant or the `/workers`
  pipeline when the Python surface encounters persistent failures.

## ❓ Troubleshooting

| Symptom | Resolution |
| --- | --- |
| `ConfigurationError: Missing required environment variable` | Ensure `OPENAI_API_KEY` and `ARCANOS_FINE_TUNED_MODEL` are exported before importing the module. |
| `The 'openai' package is required...` | Re-run `pip install -r python-client/requirements.txt` inside your virtual environment. |
| Maintenance webhook not firing | Confirm the URL is reachable and accepts anonymous POST requests with JSON payloads. Check STDOUT logs for fallback output. |
| Empty completion choices | This indicates an upstream OpenAI anomaly; retry with increased logging and capture the incident ID for AFOL. |

With this document, `docs/arcanos-overview.md` now links to a fully described and
shippable Python interface for GPT-5.1 reasoning.

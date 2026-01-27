# ARCANOS CLI (Python)

Cross-platform ARCANOS CLI daemon with voice, vision, and backend sync.

## Install (dev)

```bash
cd daemon-python
python -m venv venv
# Windows (PowerShell)
.\venv\Scripts\Activate.ps1
# macOS/Linux
source venv/bin/activate
pip install -e .
cp .env.example .env
# Set OPENAI_API_KEY (and optional BACKEND_URL/BACKEND_TOKEN)
```

## Run

```bash
arcanos
# or
python -m arcanos.cli
```

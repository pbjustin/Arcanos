# ARCANOS CLI (Python)

Cross-platform ARCANOS CLI daemon with voice, vision, and backend sync.

## Install (pipx)

```bash
pipx install "arcanos @ git+https://github.com/pbjustin/Arcanos.git#subdirectory=daemon-python"
# or, once published:
# pipx install arcanos
```

Config file locations for pipx/global installs:
- Windows: `%LOCALAPPDATA%\ARCANOS\.env`
- macOS: `~/Library/Application Support/ARCANOS/.env`
- Linux: `~/.local/share/ARCANOS/.env`

## Install (dev)

```bash
cd daemon-python
python -m venv venv
# Activate virtual environment
# On macOS/Linux:
source venv/bin/activate
# On Windows:
# .\venv\Scripts\Activate.ps1
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

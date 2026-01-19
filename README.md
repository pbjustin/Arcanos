# 🌌 ARCANOS Hybrid OS

[![Build Status](https://github.com/yourusername/arcanos-hybrid/workflows/Build,%20Sign,%20and%20Deploy%20ARCANOS/badge.svg)](https://github.com/yourusername/arcanos-hybrid/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![TypeScript](https://img.shields.io/badge/typescript-5.0+-blue.svg)](https://www.typescriptlang.org/)

**The AI-powered Windows Terminal companion that sees, hears, and acts.**

ARCANOS is a production-ready AI assistant daemon that integrates seamlessly with Windows Terminal, providing GPT-4o Mini conversation, vision analysis, voice commands, terminal automation, and advanced push-to-talk capabilities.

---

## Repository Layout (Two Codebases)

This repo currently hosts two separate codebases on `main`:
- `daemon-python/` (Python): local Windows daemon and CLI.
- `backend-typescript/` (TypeScript): cloud backend API and database integration.

They are versioned together for now but should be treated as independent codebases with separate dependencies, builds, tests, and release steps.

The pre-merge backend README is preserved at `README_PRE_MERGE.md`.

---

## Upcoming (WIP)

- **Demon**: Work in progress and an upcoming feature.

---


## ✨ Features

### 🤖 Core AI
- **GPT-4o Mini**: Fast, intelligent conversation with natural personality
- **Context Memory**: Persistent conversation history and user preferences
- **Cost Tracking**: Real-time monitoring of API usage and costs
- **Rate Limiting**: 60 requests/hour, 100k tokens/day limits

### 👁️ Vision System
- **Screen Capture**: Analyze your desktop with GPT-4o vision
- **Camera Capture**: Use webcam for visual input
- **Hotkey Integration**: F9 during push-to-talk for instant screenshots

### 🎤 Audio & Voice
- **Speech Recognition**: OpenAI Speech-to-Text (Whisper) for voice commands
- **Text-to-Speech**: Natural voice responses
- **Advanced Push-to-Talk**: Spacebar hold with VAD auto-stop
- **System Tray Indicator**: Visual feedback for PTT status
- **Multi-Hotkey**: Spacebar (PTT) + F9 (screenshot)

### 💻 Terminal Control
- **Command Execution**: Run PowerShell/CMD commands safely
- **Security**: Whitelist/blacklist system for dangerous commands
- **Windows Terminal Integration**: Custom ARCANOS Dark profile
- **Desktop Shortcuts**: Quick access to ARCANOS CLI

### 🛡️ Production Features
- **Error Handling**: Centralized, user-friendly error messages
- **Crash Recovery**: Auto-restart with intelligent limits
- **Telemetry**: Opt-in anonymous analytics (Sentry)
- **Uninstaller**: Complete Windows cleanup tool
- **Code Signing**: Trusted Windows .exe (certificates required)

### 🧪 Testing & CI/CD
- **Python Tests**: pytest suite with 95%+ coverage
- **TypeScript Tests**: Jest integration tests
- **GitHub Actions**: Automated build, sign, and deploy
- **Railway Deployment**: Cloud backend with PostgreSQL

---

## 🚀 Quick Start

Quick Start covers the local daemon; backend setup is handled separately below.

### Prerequisites
- **Windows 10/11** with Windows Terminal
- **Python 3.11+**
- **Node.js 18+** (for backend development)
- **OpenAI API Key** ([get one here](https://platform.openai.com/api-keys))

### Installation

1. **Clone the repository**:
```bash
git clone https://github.com/yourusername/arcanos-hybrid.git
cd arcanos-hybrid
```

2. **Set up Python daemon**:
```bash
cd daemon-python
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

3. **Configure environment**:
```bash
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
```

4. **Run ARCANOS**:
```bash
python cli.py
```

5. **Optional: Install Windows Terminal integration**:
   - ARCANOS will prompt you to install the Terminal profile on first run
   - Creates desktop shortcut for quick access

---

## 📖 Usage

### Basic Commands

```bash
# Natural conversation
You: hey arcanos, what can you do?
ARCANOS: I can chat, see your screen, hear your voice, and run commands!

# Vision analysis
You: see
[Takes screenshot and analyzes with GPT-4o]

# Camera capture
You: see camera
[Captures webcam image and analyzes]

# Terminal commands
You: run dir
[Executes PowerShell command safely]

# Voice commands
You: ptt
[Hold SPACEBAR to talk, release to send]
[Press F9 while holding SPACEBAR to include screenshot]

# System commands
You: stats       # Show usage statistics
You: help        # Display all commands
You: exit        # Quit ARCANOS
```

### Live API Example: Inspect Memory State

```python
# Access memory programmatically
from schema import Memory

# Load current memory state
memory = Memory()

# View statistics
stats = memory.get_statistics()
print(f"Total requests: {stats['total_requests']}")
print(f"Total cost: ${stats['total_cost']:.4f}")

# Get recent conversations
conversations = memory.get_recent_conversations(limit=5)
for conv in conversations:
    print(f"User: {conv['user']}")
    print(f"AI: {conv['ai']}")
    print(f"Tokens: {conv['tokens']}, Cost: ${conv['cost']:.4f}")
```

Or via CLI:
```powershell
# View raw memory state
Get-Content daemon-python\memories.json | ConvertFrom-Json
```

### Push-to-Talk Features

- **Hold SPACEBAR**: Record voice input (VAD auto-stops after 1.5s silence)
- **SPACEBAR + F9**: Include screenshot with voice input
- **System Tray**: Shows microphone icon while recording
- **Multi-Hotkey**: Supports custom key combinations

### Configuration

Edit `daemon-python/.env`:

```env
# Required
OPENAI_API_KEY=sk-...

# Optional
BACKEND_URL=https://your-railway-app.railway.app
BACKEND_TOKEN=your-backend-jwt
BACKEND_LOGIN_EMAIL=you@example.com
BACKEND_ROUTING_MODE=hybrid
BACKEND_DEEP_PREFIXES=deep:,backend:
BACKEND_FALLBACK_TO_LOCAL=true
BACKEND_SEND_UPDATES=true
BACKEND_VISION_ENABLED=false
BACKEND_TRANSCRIBE_ENABLED=false
MAX_REQUESTS_PER_HOUR=60
MAX_TOKENS_PER_DAY=100000
TELEMETRY_ENABLED=false
AUTO_START=false
```

If `BACKEND_URL` is set, ARCANOS will prompt for backend login on startup and store `BACKEND_TOKEN` locally.
Use `deep <prompt>` or `deep:` / `backend:` prefixes to route a request through the backend when running in hybrid mode.

### Privacy & Data Retention

- **Local-first**: Conversations, preferences, logs, and screenshots stay on disk by default under `daemon-python/`.
- **What is sent**: Only prompts, optional screenshots/camera frames, and minimal metadata required to call OpenAI (and optional backend) leave your machine.
- **Telemetry**: Off by default; enable with `TELEMETRY_ENABLED=true` (anonymous ID only, no content).
- **Retention guidance**: Keep logs/crash reports ~30 days; delete/rotate regularly. Backups in `backups/` are user-managed.

### Maintenance Scripts

```powershell
# Create a timestamped backup (.env, memories.json, logs, crash reports, telemetry)
./scripts/backup.ps1

# Run health checks (Python, env, memory file, optional backend, config validation)
./scripts/health_check.ps1
```

### Debugging in VS Code

1. Open the folder in VS Code and go to **Run and Debug**.
2. Pick **Python: ARCANOS Daemon** to debug `cli.py` with `daemon-python/.env` loaded.
3. Pick **Node: Backend (TypeScript)** to debug the API via `ts-node/register` with `backend-typescript/.env`.
4. Use **Run Daemon + Backend** (compound) to start both at once.
5. Ensure dependencies are installed (`python -m pip install -r requirements.txt`, `npm install`) and `.env` files are populated before launching.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Windows Desktop                     │
│  ┌──────────────────────────────────────────────┐  │
│  │         Windows Terminal (ARCANOS)            │  │
│  │  ┌────────────────────────────────────────┐  │  │
│  │  │    Python Daemon (cli.py)               │  │  │
│  │  │  ┌──────────────────────────────────┐  │  │  │
│  │  │  │  GPT Client (gpt_client.py)      │  │  │  │
│  │  │  │  - OpenAI SDK                     │  │  │  │
│  │  │  │  - Rate Limiting                  │  │  │  │
│  │  │  │  - Caching                        │  │  │  │
│  │  │  └──────────────────────────────────┘  │  │  │
│  │  │  ┌──────────────────────────────────┐  │  │  │
│  │  │  │  Vision (vision.py)               │  │  │  │
│  │  │  │  - Screen/Camera Capture          │  │  │  │
│  │  │  │  - GPT-4o Vision                  │  │  │  │
│  │  │  └──────────────────────────────────┘  │  │  │
│  │  │  ┌──────────────────────────────────┐  │  │  │
│  │  │  │  Audio (audio.py, PTT)            │  │  │  │
│  │  │  │  - Speech Recognition             │  │  │  │
│  │  │  │  - TTS                            │  │  │  │
│  │  │  │  - VAD Auto-Stop                  │  │  │  │
│  │  │  └──────────────────────────────────┘  │  │  │
│  │  │  ┌──────────────────────────────────┐  │  │  │
│  │  │  │  Terminal (terminal.py)           │  │  │  │
│  │  │  │  - PowerShell/CMD                 │  │  │  │
│  │  │  │  - Security Checks                │  │  │  │
│  │  │  └──────────────────────────────────┘  │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                         ↕
                  [HTTPS/WSS]
                         ↕
┌─────────────────────────────────────────────────────┐
│            Railway Cloud (Backend)                   │
│  ┌──────────────────────────────────────────────┐  │
│  │   TypeScript Express Server (index.ts)        │  │
│  │  ┌────────────────────────────────────────┐  │  │
│  │  │  API Routes                             │  │  │
│  │  │  - /api/ask (conversation)              │  │  │
│  │  │  - /api/update (memory)                 │  │  │
│  │  │  - /api/audit (telemetry)               │  │  │
│  │  │  - /api/health (status)                 │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  │  ┌────────────────────────────────────────┐  │  │
│  │  │  PostgreSQL Database                    │  │  │
│  │  │  - conversations table                  │  │  │
│  │  │  - audit_logs table                     │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 🧪 Testing

### Run Python tests:
```bash
cd daemon-python
pytest tests/ -v --cov
```

### Run TypeScript tests:
```bash
cd backend-typescript
npm test
```

### Run all tests:
```bash
# From project root
pytest daemon-python/tests/ -v
cd backend-typescript && npm test
```

---

## 📦 Building .exe

### Build unsigned .exe:
```bash
cd daemon-python
pyinstaller arcanos.spec
# Output: daemon-python/dist/ARCANOS.exe
```

### Build signed .exe (requires certificate):
```bash
# 1. Obtain code signing certificate (.pfx)
# 2. Set environment variable:
$env:CERT_PASSWORD="your_cert_password"

# 3. Build and sign:
pyinstaller arcanos.spec
signtool sign /f cert.pfx /p %CERT_PASSWORD% /tr http://timestamp.digicert.com /td sha256 /fd sha256 dist/ARCANOS.exe
```

### Distribute via GitHub Releases:
1. Create release on GitHub
2. Upload `ARCANOS.exe` as release asset
3. Users download and run directly

---

## 🔧 Backend Deployment (Railway)

### Prerequisites:
- Railway account ([railway.app](https://railway.app))
- PostgreSQL database provisioned

### Deploy steps:

1. **Connect GitHub repository** to Railway

2. **Set environment variables**:
```env
DATABASE_URL=postgresql://...
JWT_SECRET=your_random_secret_key_here
AUTH_USER_EMAIL=admin@example.com
AUTH_PASSWORD_SALT=replace-with-generated-salt
AUTH_PASSWORD_HASH=replace-with-generated-hash
PORT=3000
NODE_ENV=production
```

Generate auth hash/salt (Node.js):
```bash
node -e "const crypto=require('crypto'); const salt=crypto.randomBytes(16).toString('hex'); const hash=crypto.scryptSync('your-password', salt, 64).toString('hex'); console.log('AUTH_PASSWORD_SALT=' + salt); console.log('AUTH_PASSWORD_HASH=' + hash);"
```

3. **Railway auto-deploys** on push to main branch

4. **Get your backend URL**:
   - Example: `https://arcanos-backend-production.up.railway.app`
   - Update `BACKEND_URL` in daemon `.env`

---

## 🗑️ Uninstallation

### Option 1: Use built-in uninstaller
```bash
python uninstall.py
```

### Option 2: Manual removal
1. Delete ARCANOS folder
2. Remove Windows Terminal profile (optional)
3. Delete desktop shortcut
4. Remove from startup (if enabled)

The uninstaller provides option to backup user data before removal.

---

## 📊 Telemetry & Privacy

ARCANOS includes **opt-in** anonymous telemetry via Sentry:
- Crash reports for debugging
- Performance metrics
- Feature usage statistics
- **NO personal data, conversation content, or API keys collected**

Disable telemetry in `.env`:
```env
TELEMETRY_ENABLED=false
```

Or decline during first-run setup.

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

### Development setup:
```bash
# Python daemon
cd daemon-python
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt

# TypeScript backend
cd backend-typescript
npm install
npm run dev
```

### Code quality:
```bash
# Python linting
flake8 daemon-python/
black daemon-python/

# TypeScript linting
cd backend-typescript
npm run lint
npm run format
```

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/arcanos-hybrid/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/arcanos-hybrid/discussions)
- **Email**: your.email@example.com

---

## 🙏 Acknowledgments

- **OpenAI** for GPT-4o and GPT-4o Mini APIs
- **Rich** library for beautiful terminal UI
- **Railway** for seamless cloud deployment
- **Windows Terminal** team for extensible terminal platform

---

## 🗺️ Roadmap

### v1.0 (Current)
- ✅ Core AI conversation
- ✅ Vision system
- ✅ Audio & PTT
- ✅ Terminal control
- ✅ Production features

### v1.1 (Planned)
- [ ] Auto-start on Windows login
- [ ] Settings UI (web dashboard)
- [ ] Backup/restore user data
- [ ] Plugin system for extensions
- [ ] Multi-language support

### v2.0 (Future)
- [ ] Browser extension for web integration
- [ ] Mobile companion app (Android/iOS)
- [ ] Team collaboration features
- [ ] Custom model support (local LLMs)

---

<div align="center">

**Made with ❤️ by the ARCANOS team**

[⭐ Star us on GitHub](https://github.com/yourusername/arcanos-hybrid) • [🐦 Follow on Twitter](https://twitter.com/yourhandle)

</div>

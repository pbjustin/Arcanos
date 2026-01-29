# 🚀 ARCANOS Quick Start Guide

Welcome to ARCANOS! This guide will get you up and running in under 5 minutes.

## 📋 Prerequisites

Before you begin, make sure you have:

- ✅ Windows 10/11
- ✅ Python 3.11 or higher ([Download](https://www.python.org/downloads/))
- ✅ OpenAI API Key ([Get one here](https://platform.openai.com/api-keys))
- ✅ Windows Terminal (recommended, comes with Windows 11)

## ⚡ Quick Installation

### Option 0: Install with pipx (recommended for “type `arcanos` anywhere”)

If you want `arcanos` available from any terminal without activating a venv:

```powershell
python -m pip install --user pipx
pipx ensurepath
pipx install "arcanos @ git+https://github.com/pbjustin/Arcanos.git#subdirectory=daemon-python"
```

Open a new terminal, then run:

```powershell
arcanos
```

### Option 1: Automated Setup (Repo Clone)

Open PowerShell in the repository root and run:

```powershell
.\setup.ps1
```

The setup wizard will:
1. Create a Python virtual environment
2. Install all dependencies
3. Install the ARCANOS CLI package
4. Configure your API key
5. (Optional) Add `arcanos` to your PATH
6. Launch ARCANOS

### Option 2: Manual Setup

If you prefer manual installation:

```powershell
# 1. Navigate to daemon-python folder
cd daemon-python

# 2. Create virtual environment
python -m venv venv

# 3. Activate virtual environment
.\venv\Scripts\Activate.ps1

# 4. Install dependencies
python -m pip install -r requirements.txt

# 5. Install the ARCANOS CLI package
python -m pip install -e .

# 6. Configure .env file
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# 7. Run ARCANOS
arcanos
# or
python -m arcanos.cli
```

## 🎯 First Steps

Once ARCANOS starts, you'll see a welcome message. Try these commands:

### 1. Basic Conversation
```
💬 You: hey arcanos, introduce yourself
```

### 2. See Your Screen
```
💬 You: see
```
ARCANOS will capture and analyze your screen!

### 3. Use Voice Input
```
💬 You: voice
```
Then speak your question when prompted.

### 4. Try Push-to-Talk
```
💬 You: ptt
```
Hold **SPACEBAR** to talk, release to send. Press **F9** while talking to include a screenshot!

### 5. Run Terminal Commands
```
💬 You: run Get-Date
💬 You: run Get-Process | Select-Object -First 5
```

### 6. Get Help
```
💬 You: help
```

## 📊 Viewing Stats

Check your usage at any time:

```
💬 You: stats
```

You'll see:
- Requests used this hour
- Tokens used today
- Total cost
- Remaining limits

## ⚙️ Configuration

Edit `daemon-python/.env` (repo/venv installs) or your user config file (pipx/global installs) to customize:

- Windows: `%LOCALAPPDATA%\ARCANOS\.env`
- macOS: `~/Library/Application Support/ARCANOS/.env`
- Linux: `~/.local/share/ARCANOS/.env`

```env
# Required
OPENAI_API_KEY=sk-your-key-here

# Optional - Rate Limits
MAX_REQUESTS_PER_HOUR=60
MAX_TOKENS_PER_DAY=100000
MAX_COST_PER_DAY=10.0

# Optional - Features
TELEMETRY_ENABLED=false
VOICE_ENABLED=true
VISION_ENABLED=true

# Optional - AI Settings
TEMPERATURE=0.7
MAX_TOKENS=500
```

## 🪟 Windows Terminal Integration

Windows Terminal profile/shortcut integration has been removed in the cross-platform CLI build.

## 🔧 Running the CLI Agent

The CLI agent runs as the `arcanos` command:

```powershell
arcanos
```

If you are running from source without installing the package:

```powershell
# Run the CLI agent
cd daemon-python
python -m arcanos.cli
```

### Code Signing (Optional)

If you have a code signing certificate:

```powershell
.\scripts\build.ps1 -Sign -CertPath "path\to\cert.pfx" -CertPassword "password"
```

## 🌐 Backend Deployment (Optional)

The backend is optional but provides cloud sync and analytics.

### Prerequisites:
- Railway account ([Sign up free](https://railway.app))
- PostgreSQL database (Railway provides this)

### Deploy:

1. Install Railway CLI:
```powershell
npm install -g @railway/cli
```

2. Login to Railway:
```powershell
railway login
```

3. Deploy:
```powershell
.\scripts\deploy-backend.ps1
```

4. Set environment variables in Railway dashboard:
   - `DATABASE_URL` (auto-provided by Railway)
   - `JWT_SECRET` (generate a random string)
   - `PORT=3000`
   - `NODE_ENV=production`

5. Get your backend URL and update `daemon-python/.env`:
```env
BACKEND_URL=https://your-app.railway.app
```

## 🧪 Running Tests

### Python tests:
```powershell
cd daemon-python
pytest ..\tests\test_daemon.py -v
```

### TypeScript tests:
```powershell
npm test
```

## ❓ Troubleshooting

### "OpenAI API key is required"
- Make sure you've added your API key to the correct `.env`:
  - Repo/venv installs: `daemon-python/.env`
  - pipx/global installs: `%LOCALAPPDATA%\ARCANOS\.env` (Windows), `~/Library/Application Support/ARCANOS/.env` (macOS), `~/.local/share/ARCANOS/.env` (Linux)
- Format: `OPENAI_API_KEY=sk-...`

### "Module not found" errors
- Make sure virtual environment is activated
- Reinstall dependencies: `python -m pip install -r requirements.txt`

### Microphone not working
- Check Windows privacy settings
- Ensure microphone permissions are granted
- Test with: `💬 You: voice`

### Camera not working for "see camera"
- Check Windows privacy settings
- Ensure camera permissions are granted
- Try disconnecting/reconnecting USB cameras

### Rate limit errors
- Check your usage: `💬 You: stats`
- Adjust limits in `.env` if needed
- Wait for hourly/daily reset

## 📚 Learn More

- **Full Documentation:** [README.md](README.md)
- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **License:** [LICENSE](LICENSE)

## 💬 Support

- **Issues:** [GitHub Issues](https://github.com/pbjustin/Arcanos/issues)
- **Discussions:** [GitHub Discussions](https://github.com/pbjustin/Arcanos/discussions)

## 🎉 You're Ready!

You now have ARCANOS fully set up! Start chatting, experiment with vision, voice, and terminal commands.

Have fun exploring! 🌌

---

**Next Steps:**
1. ⭐ Star the repository on GitHub
2. 💬 Join our community discussions
3. 🤝 Consider contributing improvements
4. 📣 Share ARCANOS with friends!

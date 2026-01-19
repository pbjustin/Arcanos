# ARCANOS Architecture

## System Overview

ARCANOS is a hybrid AI assistant system consisting of two main components:

1. **Local Daemon** (Python) - Runs on user's machine
2. **Cloud Backend** (TypeScript) - Hosted on Railway.app

```
┌─────────────────────────────────────────────┐
│            User's Windows PC                 │
│                                              │
│  ┌────────────────────────────────────┐    │
│  │     Windows Terminal                │    │
│  │                                     │    │
│  │  ┌──────────────────────────────┐  │    │
│  │  │  ARCANOS Daemon (cli.py)     │  │    │
│  │  │                              │  │    │
│  │  │  ┌────────────────────────┐ │  │    │
│  │  │  │  GPT Client            │ │  │    │
│  │  │  │  - OpenAI API          │ │  │    │
│  │  │  │  - Rate Limiting       │ │  │    │
│  │  │  │  - Caching             │ │  │    │
│  │  │  └────────────────────────┘ │  │    │
│  │  │                              │  │    │
│  │  │  ┌────────────────────────┐ │  │    │
│  │  │  │  Vision System         │ │  │    │
│  │  │  │  - Screen Capture      │ │  │    │
│  │  │  │  - Camera Capture      │ │  │    │
│  │  │  │  - GPT-4o Vision       │ │  │    │
│  │  │  └────────────────────────┘ │  │    │
│  │  │                              │  │    │
│  │  │  ┌────────────────────────┐ │  │    │
│  │  │  │  Audio System          │ │  │    │
│  │  │  │  - Speech Recognition  │ │  │    │
│  │  │  │  - Text-to-Speech      │ │  │    │
│  │  │  │  - Push-to-Talk        │ │  │    │
│  │  │  │  - VAD Auto-Stop       │ │  │    │
│  │  │  └────────────────────────┘ │  │    │
│  │  │                              │  │    │
│  │  │  ┌────────────────────────┐ │  │    │
│  │  │  │  Terminal Controller   │ │  │    │
│  │  │  │  - PowerShell/CMD      │ │  │    │
│  │  │  │  - Security Checks     │ │  │    │
│  │  │  └────────────────────────┘ │  │    │
│  │  └──────────────────────────────┘  │    │
│  └────────────────────────────────────┘    │
│                                              │
│  Local Storage:                              │
│  - memories.json (conversation history)      │
│  - logs/ (error logs)                        │
│  - screenshots/ (captured images)            │
└─────────────────────────────────────────────┘
                     ↕
              [HTTPS/WSS]
                     ↕
┌─────────────────────────────────────────────┐
│        Railway Cloud (Backend)               │
│                                              │
│  ┌────────────────────────────────────┐    │
│  │  Express Server (index.ts)          │    │
│  │                                     │    │
│  │  ┌──────────────────────────────┐  │    │
│  │  │  API Routes                  │  │    │
│  │  │  - /api/ask (conversation)   │  │    │
│  │  │  - /api/update (memory)      │  │    │
│  │  │  - /api/audit (telemetry)    │  │    │
│  │  │  - /api/health (status)      │  │    │
│  │  └──────────────────────────────┘  │    │
│  │                                     │    │
│  │  ┌──────────────────────────────┐  │    │
│  │  │  Middleware                  │  │    │
│  │  │  - JWT Authentication        │  │    │
│  │  │  - Rate Limiting             │  │    │
│  │  │  - Helmet Security           │  │    │
│  │  │  - CORS                      │  │    │
│  │  └──────────────────────────────┘  │    │
│  └────────────────────────────────────┘    │
│                                              │
│  ┌────────────────────────────────────┐    │
│  │  PostgreSQL Database                │    │
│  │                                     │    │
│  │  Tables:                            │    │
│  │  - conversations                    │    │
│  │  - audit_logs                       │    │
│  └────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

## Data Flow

### 1. Conversation Flow

```
User Input → CLI → Rate Limiter → GPT Client → OpenAI API
                                         ↓
                                    Response
                                         ↓
                              Memory (local JSON)
                                         ↓
                              Backend API (optional)
                                         ↓
                              PostgreSQL (cloud)
```

### 2. Vision Flow

```
User: "see" → Vision System → Screen Capture (PyAutoGUI)
                    ↓
              Image Encoding (base64)
                    ↓
              GPT-4o Vision API
                    ↓
              Response → Display to User
```

### 3. Push-to-Talk Flow

```
User: Hold SPACEBAR → PTT Manager → Audio System → Microphone
                                            ↓
                                    Voice Activity Detection
                                            ↓
                                    Auto-stop on silence
                                            ↓
                                    Speech Recognition
                                            ↓
                                    Text → GPT Client
```

## Component Details

### Python Daemon (Local)

**Purpose:** Main user interface and local processing

**Key Files:**
- `cli.py` - Main CLI loop and command handling
- `gpt_client.py` - OpenAI API integration
- `vision.py` - Screen/camera capture and analysis
- `audio.py` - Speech recognition and TTS
- `terminal.py` - Command execution with security
- `push_to_talk.py` - Advanced PTT system
- `rate_limiter.py` - Request/token/cost tracking
- `error_handler.py` - Centralized error handling
- `crash_recovery.py` - Auto-restart on crash

**Dependencies:**
- openai - GPT API
- rich - Terminal UI
- pyautogui - Screen capture
- opencv-python - Camera capture
- speechrecognition - Voice input
- pyttsx3 - Text-to-speech
- pynput - Hotkey detection
- webrtcvad - Voice activity detection

### TypeScript Backend (Cloud)

**Purpose:** Data persistence and analytics

**Key Files:**
- `index.ts` - Express server setup
- `database.ts` - PostgreSQL connection
- `auth.ts` - JWT authentication
- `logger.ts` - Winston logging
- `routes/` - API endpoints

**Dependencies:**
- express - Web framework
- pg - PostgreSQL client
- helmet - Security headers
- express-rate-limit - API rate limiting
- jsonwebtoken - Authentication

## Security

### Local Security

1. **Command Blacklist:** Dangerous commands blocked by default
2. **API Key Storage:** Stored in `.env` file (gitignored)
3. **Local Memory:** Conversations stored locally in JSON
4. **Crash Logs:** Sensitive data filtered before logging

### Cloud Security

1. **JWT Authentication:** All API endpoints require valid JWT
2. **Rate Limiting:** 100 requests per 15 minutes per IP
3. **Helmet:** Security headers (XSS, clickjacking protection)
4. **CORS:** Restricted to allowed origins
5. **SQL Injection:** Parameterized queries via pg library

## Performance

### Local Performance

- **GPT Response Time:** 1-3 seconds (depends on OpenAI)
- **Vision Analysis:** 2-5 seconds (GPT-4o Vision)
- **Voice Recognition:** 0.5-1 second (OpenAI Speech-to-Text)
- **Memory Storage:** < 100ms (local JSON)

### Optimization Strategies

1. **Response Caching:** 5-minute TTL for identical requests
2. **Rate Limiting:** Prevents excessive API usage
3. **Lazy Loading:** Modules loaded on-demand
4. **Connection Pooling:** PostgreSQL connection reuse

## Scalability

### Current Limits

- **Local:** Single user per machine
- **Backend:** ~1000 concurrent users (Railway tier)
- **Database:** ~10GB storage (Railway tier)

### Scaling Options

1. **Horizontal Scaling:** Deploy multiple backend instances
2. **Database Scaling:** Upgrade Railway plan or migrate to dedicated server
3. **CDN:** Cache static assets (future web UI)
4. **Sharding:** Partition users across databases

## Deployment

### Local Deployment

1. Clone repository
2. Run `setup.ps1`
3. Add OpenAI API key to `.env`
4. Run `python cli.py`

### Backend Deployment

1. Push to GitHub
2. Connect Railway to repository
3. Set environment variables
4. Railway auto-deploys on push

### CI/CD Pipeline

1. **On Push:** Run tests (pytest + jest)
2. **On Tag:** Build .exe with PyInstaller
3. **If Cert Available:** Sign executable with signtool
4. **Create Release:** Upload signed .exe to GitHub Releases
5. **Deploy Backend:** Railway auto-deploy

## Monitoring

### Local Monitoring

- Crash logs: `daemon-python/crash_reports/`
- Error logs: `daemon-python/logs/errors.log`
- Usage stats: In-memory (displayed in CLI)

### Cloud Monitoring

- Winston logs: `logs/combined.log`, `logs/error.log`
- Sentry (optional): Real-time error tracking
- Railway metrics: CPU, memory, requests

## Future Architecture

### Planned Improvements

1. **WebSocket Support:** Real-time bidirectional communication
2. **Web UI:** Browser-based dashboard for settings
3. **Mobile App:** iOS/Android companion app
4. **Plugin System:** Third-party extensions
5. **Local LLM Support:** Run models locally (Ollama, LM Studio)

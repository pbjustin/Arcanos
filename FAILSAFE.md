# 🆘 ARCANOS Failsafe & Recovery Guide

**Emergency recovery procedures for ARCANOS daemon failures**

---

## 🚨 Quick Recovery

### Daemon Won't Start

```powershell
# 1. Check if Python virtual environment is activated
cd C:\arcanos-hybrid\daemon-python
.\venv\Scripts\Activate.ps1

# 2. Try running directly
python cli.py

# 3. If error, check dependencies
python -m pip install -r requirements.txt --force-reinstall
```

### Crash Loop Detected

```powershell
# 1. View crash logs
Get-Content daemon-python\crash_reports\crash_log.txt -Tail 20

# 2. Reset crash counter
Remove-Item daemon-python\crash_reports\* -Force

# 3. Restart with clean state
python cli.py
```

### Memory Corruption

```powershell
# 1. Backup corrupted memory
Copy-Item daemon-python\memories.json daemon-python\backups\memories_corrupted.json

# 2. Restore from template
Copy-Item daemon-python\memory\bootstrap_template.json daemon-python\memories.json

# 3. Restart daemon
python cli.py
```

---

## 📋 Recovery Time Objectives (RTO)

| Failure Type | Detection Time | Recovery Time | Data Loss |
|--------------|----------------|---------------|-----------|
| Daemon crash | < 1 second | < 5 seconds | None (auto-restart) |
| Memory corruption | < 1 second | < 10 seconds | Last session only |
| API failure | Immediate | Retry in 2-10s | None (cached) |
| Rate limit hit | Immediate | Next window | None (queued) |
| Config error | On startup | < 30 seconds | None |
| Module import error | On startup | Manual fix | None |
| Backend unavailable | < 5 seconds | Degrade gracefully | None (local mode) |

**Overall RTO Target:** < 30 seconds for 95% of failures

---

## 🔧 Module-Specific Recovery

### GPT Client Failure

**Symptoms:**
- "OpenAI API key is required"
- "Rate limit exceeded"
- "Connection timeout"

**Recovery:**
```powershell
# 1. Check API key
Get-Content daemon-python\.env | Select-String "OPENAI_API_KEY"

# 2. Test API key
python -c "from gpt_client import GPTClient; client = GPTClient(); print('API key valid')"

# 3. If invalid, update .env
notepad daemon-python\.env
```

**Rollback:** Use cached responses (5-minute TTL) if available

### Vision System Failure

**Symptoms:**
- "Failed to capture screenshot"
- "Camera not accessible"
- "Vision model not found"

**Recovery:**
```powershell
# 1. Test screen capture
python -c "import pyautogui; pyautogui.screenshot().save('test.png'); print('Screen capture OK')"

# 2. Test camera
python -c "import cv2; cap = cv2.VideoCapture(0); print('Camera OK' if cap.isOpened() else 'Camera FAIL')"

# 3. Disable vision temporarily
# Edit .env: VISION_ENABLED=false
```

**Rollback:** Disable vision features, conversation-only mode

### Audio System Failure

**Symptoms:**
- "Microphone not accessible"
- "No speech detected"
- "TTS unavailable"

**Recovery:**
```powershell
# 1. Check microphone permissions
# Windows Settings → Privacy → Microphone

# 2. Test microphone
python -c "from audio import AudioSystem; audio = AudioSystem(); print('Mic OK' if audio.test_microphone() else 'Mic FAIL')"

# 3. Disable audio temporarily
# Edit .env: VOICE_ENABLED=false
```

**Rollback:** Text-only mode, disable PTT

### Terminal Controller Failure

**Symptoms:**
- "Command execution failed"
- "Permission denied"
- "Dangerous command blocked"

**Recovery:**
```powershell
# 1. Test PowerShell
powershell -Command "Write-Output 'Test'"

# 2. Check blacklist
Get-Content daemon-python\.env | Select-String "ALLOW_DANGEROUS_COMMANDS"

# 3. Adjust security settings if needed
# Edit .env: ALLOW_DANGEROUS_COMMANDS=true (CAUTION!)
```

**Rollback:** Disable terminal features, conversation-only

### Backend Connection Failure

**Symptoms:**
- "Failed to connect to backend"
- "Backend unavailable"
- "Authentication failed"

**Recovery:**
```powershell
# 1. Check backend URL
Get-Content daemon-python\.env | Select-String "BACKEND_URL"

# 2. Test connection
Invoke-WebRequest -Uri "https://your-backend.railway.app/api/health"

# 3. Disable backend
# Edit .env: BACKEND_URL=
```

**Rollback:** Local-only mode (default behavior)

---

## 📊 Health Check Commands

### Self-Diagnostic

```powershell
# Run comprehensive health check
python -c "
from config import Config
from gpt_client import GPTClient
from audio import AudioSystem

print('Config:', 'OK' if Config.validate()[0] else 'FAIL')
print('GPT Client:', 'OK' if Config.OPENAI_API_KEY else 'FAIL')
print('Audio:', 'OK' if AudioSystem().test_microphone() else 'FAIL')
"
```

### Component Status

```python
# Inside ARCANOS CLI
💬 You: stats
# Shows: requests, tokens, cost, rate limits

# Check specific features
💬 You: see
# Tests vision system

💬 You: voice
# Tests audio system

💬 You: run Get-Date
# Tests terminal controller
```

---

## 🔄 Rollback Procedures

### Rollback to Previous Version

```powershell
# 1. If using Git
git log --oneline
git checkout <previous-commit-hash>

# 2. Reinstall dependencies
python -m pip install -r requirements.txt

# 3. Restore configuration
Copy-Item .env.backup .env
```

### Factory Reset

```powershell
# ⚠️ WARNING: This deletes all data!

# 1. Backup user data
python uninstall.py
# Choose "Yes" for backup

# 2. Delete all data
Remove-Item daemon-python\memories.json
Remove-Item daemon-python\logs\* -Recurse -Force
Remove-Item daemon-python\crash_reports\* -Recurse -Force
Remove-Item daemon-python\telemetry\* -Recurse -Force
Remove-Item daemon-python\screenshots\* -Recurse -Force

# 3. Restore template
Copy-Item daemon-python\memory\bootstrap_template.json daemon-python\memories.json

# 4. Restart
python cli.py
```

### Backup & Restore

**Create Backup:**
```powershell
# Manual backup
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupPath = ".\backups\backup_$timestamp"
New-Item -ItemType Directory -Path $backupPath -Force
Copy-Item daemon-python\memories.json $backupPath\
Copy-Item daemon-python\.env $backupPath\
Copy-Item daemon-python\logs $backupPath\logs -Recurse
Compress-Archive -Path $backupPath -DestinationPath "$backupPath.zip"
```

**Restore Backup:**
```powershell
# Extract backup
Expand-Archive -Path ".\backups\backup_20260118_120000.zip" -DestinationPath ".\temp_restore"

# Restore files
Copy-Item .\temp_restore\memories.json daemon-python\
Copy-Item .\temp_restore\.env daemon-python\
Copy-Item .\temp_restore\logs\* daemon-python\logs\ -Recurse

# Clean up
Remove-Item .\temp_restore -Recurse -Force
```

---

## 🛡️ Preventive Measures

### Automated Backups

Add to Windows Task Scheduler:

```powershell
# Create backup task (run weekly)
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-File C:\arcanos-hybrid\scripts\backup.ps1"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 2am
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "ARCANOS Backup" -Description "Weekly ARCANOS data backup"
```

### Health Monitoring

```powershell
# Create monitoring task (run daily)
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-File C:\arcanos-hybrid\scripts\health_check.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At 8am
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "ARCANOS Health Check"
```

### Log Rotation

```powershell
# Clean old logs (keep last 30 days)
Get-ChildItem daemon-python\logs\*.log | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item
Get-ChildItem daemon-python\crash_reports\* | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item
```

---

## 🧪 Testing Recovery

### Simulate Failures

```powershell
# 1. Corrupt memory (safe test)
Copy-Item daemon-python\memories.json daemon-python\memories_backup.json
"invalid json{" | Set-Content daemon-python\memories.json
python cli.py
# Should recover automatically

# 2. Test crash recovery
python -c "from cli import ArcanosCLI; raise Exception('Test crash')"
# Should offer restart

# 3. Test rate limiting
# Edit .env: MAX_REQUESTS_PER_HOUR=1
# Make 2 requests rapidly
```

---

## 📞 Emergency Contacts

### Self-Service

1. **Check Documentation:** [README.md](README.md), [QUICKSTART.md](QUICKSTART.md)
2. **View Logs:** `daemon-python\logs\errors.log`
3. **Check Issues:** https://github.com/yourusername/arcanos-hybrid/issues

### Community Support

- **GitHub Discussions:** https://github.com/yourusername/arcanos-hybrid/discussions
- **Discord:** (if community exists)

### Critical Failures

For security-critical failures (data breach, API key leak):
- Email: security@arcanos.example.com
- See: [SECURITY.md](SECURITY.md)

---

## 📈 Recovery Success Metrics

Track recovery effectiveness:

```json
{
  "total_crashes": 5,
  "auto_recovered": 4,
  "manual_intervention": 1,
  "data_loss_incidents": 0,
  "average_recovery_time_seconds": 3.2,
  "rto_met_percentage": 95.0
}
```

---

## 🎯 Recovery Priority Matrix

| Failure Type | Priority | Auto-Recovery | Manual Steps Required |
|--------------|----------|---------------|----------------------|
| Memory corruption | P0 | ✅ Yes | Load template |
| API key invalid | P0 | ❌ No | Update .env |
| Daemon crash | P1 | ✅ Yes | None (auto-restart) |
| Module import error | P1 | ❌ No | Reinstall dependencies |
| Backend unavailable | P2 | ✅ Yes | None (local mode) |
| Vision failure | P2 | ✅ Yes | None (disable vision) |
| Audio failure | P3 | ✅ Yes | None (text-only) |
| Rate limit hit | P3 | ✅ Yes | None (wait) |

---

**Last Updated:** January 18, 2026  
**Version:** 1.0.0

Keep this guide accessible for emergency recovery scenarios.

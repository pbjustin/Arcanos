# Security Policy

## 🔒 Security Overview

ARCANOS takes security seriously. This document outlines our security model, responsible disclosure process, and best practices.

---

## 🎯 Threat Model

### Attack Surfaces

1. **Local Daemon**
   - Terminal command injection
   - File system access
   - Environment variable exposure
   - Memory data tampering

2. **API Integration**
   - OpenAI API key exposure
   - Man-in-the-middle attacks
   - API response injection

3. **Backend (if deployed)**
   - SQL injection
   - JWT token theft
   - Rate limit bypass
   - Unauthorized data access

### Trust Boundaries

```
┌─────────────────────────────────────┐
│  User's Machine (Trusted)           │
│  ├─ ARCANOS Daemon                  │
│  ├─ Local Memory (JSON)             │
│  └─ Windows Terminal                │
└─────────────────────────────────────┘
           ↕ HTTPS (Encrypted)
┌─────────────────────────────────────┐
│  OpenAI API (Trusted Third Party)   │
└─────────────────────────────────────┘
           ↕ HTTPS (Encrypted)
┌─────────────────────────────────────┐
│  Backend (Optional, User-Controlled)│
│  ├─ Express Server                  │
│  └─ PostgreSQL Database             │
└─────────────────────────────────────┘
```

---

## 🔑 Secret Storage Policy

### Environment Variables (.env)

**NEVER commit `.env` files to version control.**

The `.env` file contains sensitive credentials and must be kept private. Always use `.env.example` as a template (which contains no real secrets).

```env
# ✅ GOOD - Stored in .env (gitignored)
OPENAI_API_KEY=sk-...
BACKEND_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
DEBUG_SERVER_TOKEN=your-secure-token-here

# ❌ BAD - Never hardcode in source code
api_key = "sk-proj-abc123..."

# ❌ BAD - Never commit .env to Git
git add .env  # DON'T DO THIS
```

### Storage Locations

| Secret Type | Storage Method | Access Control |
|-------------|----------------|----------------|
| OpenAI API Key | `.env` file | File system permissions |
| JWT Secret | `.env` or Railway env vars | Railway dashboard access |
| Database URL | `.env` or Railway env vars | Railway dashboard access |
| User conversations | `memories.json` | Local file system |
| Telemetry ID | `telemetry/user_id.txt` | Anonymous UUID |

### Best Practices

1. **Rotate API Keys Regularly**
   - Change OpenAI API key every 90 days (or immediately if suspected compromise)
   - Rotate backend JWT token via backend login flow
   - Regenerate `DEBUG_SERVER_TOKEN` if exposed: `python -c "import secrets; print(secrets.token_urlsafe(32))"`
   - Update `.env` with new values and restart the daemon

2. **Use Environment Variables**
   ```powershell
   # Set temporarily (not recommended for production)
   $env:OPENAI_API_KEY="sk-..."
   python -m arcanos.cli
   
   # Or use .env file (recommended)
   # Copy .env.example to .env and fill in values
   ```

3. **Never Log Secrets**
   - All logging filters API keys automatically via `sanitize_sensitive_data()`
   - Error messages redact sensitive data
   - Command execution logs use SHA-256 hashes, never raw commands

4. **Backend HTTPS Enforcement**
   - Backend URLs must use `https://` unless `BACKEND_ALLOW_HTTP=true` (dev only)
   - Localhost (`127.0.0.1`, `localhost`) allows HTTP for development
   - Production deployments should always use HTTPS

5. **JWT Verification** (Recommended)
   - Configure `BACKEND_JWT_SECRET`, `BACKEND_JWT_PUBLIC_KEY`, or `BACKEND_JWT_JWKS_URL` to enable signature verification
   - Without verification keys, only expiration (`exp`) is checked (security warning logged)
   - Invalid tokens are rejected at bootstrap and refresh

6. **Debug Server Security**
   - Always set `DEBUG_SERVER_TOKEN` (required for non-read-only endpoints)
   - Query parameter auth (`?token=`) is disabled by default (`DEBUG_SERVER_ALLOW_QUERY_TOKEN=false`)
   - Rate limiting enforced per IP (`DEBUG_SERVER_RATE_LIMIT`, default: 60 requests/minute)
   - Keep `DEBUG_SERVER_ALLOW_UNAUTHENTICATED=false` unless in a secure dev environment

7. **Backup Encryption** (Future)
   - Encrypt `memories.json` at rest
   - Use Windows DPAPI or OS keychain for key storage

---

## 🧠 Memory Access Policy

### Data Classification

| Data Type | Sensitivity | Storage | Encryption |
|-----------|-------------|---------|------------|
| Conversations | HIGH | Local JSON | Plaintext* |
| API Keys | CRITICAL | .env file | Plaintext* |
| User Preferences | MEDIUM | Local JSON | Plaintext |
| Statistics | LOW | Local JSON | Plaintext |
| Telemetry ID | LOW | Local file | Anonymous |
| Audit Logs | MEDIUM | PostgreSQL | In-transit (TLS) |

*Plaintext with file system permissions as primary protection

### Access Control Matrix

```
┌─────────────────┬──────┬───────┬────────┬──────────┐
│ Actor           │ Read │ Write │ Delete │ Execute  │
├─────────────────┼──────┼───────┼────────┼──────────┤
│ User            │  ✅  │  ✅   │  ✅    │   ✅     │
│ ARCANOS Daemon  │  ✅  │  ✅   │  ❌    │   N/A    │
│ Backend API     │  ✅  │  ✅   │  ❌    │   N/A    │
│ Other Users     │  ❌  │  ❌   │  ❌    │   ❌     │
│ Malicious Code  │  ❌  │  ❌   │  ❌    │   ❌     │
└─────────────────┴──────┴───────┴────────┴──────────┘
```

### Memory Isolation

1. **Single User Model**
   - Each installation serves one user
   - No multi-tenancy at daemon level
   - Backend isolates users by JWT

2. **Data Boundaries**
   ```python
   # memories.json is user-specific
   {
     "user": { "name": "Alice" },
     "conversations": [ /* Alice's only */ ]
   }
   ```

3. **No Cross-Contamination**
   - Conversations never shared between users
   - Backend uses `user_id` for isolation
   - JWT tokens are per-user

---

## 🔏 Privacy & Data Handling

### What Data Leaves Your Machine
- **Sent to OpenAI**: Prompt text, optional screenshots/camera frames, and relevant metadata needed to fulfill the request
- **Sent to Backend (optional)**: Conversation summaries, audit logs, and user IDs (JWT-authenticated)
- **Never Sent**: `.env` contents, raw terminal command history, full memory file unless explicitly pushed

### What Stays Local
- `memories.json` (conversation history, preferences)
- Logs, crash reports, telemetry ID (if enabled)
- Screenshots captured during vision/voice flows

### Telemetry (Opt-In)
- Anonymous ID only; no conversation content
- Can be disabled via `TELEMETRY_ENABLED=false`

---

## 🗄️ Data Retention & Deletion Policy

| Data Type | Default Retention | Location | How to Delete |
|-----------|-------------------|----------|---------------|
| Conversations (`memories.json`) | Persistent until user deletes | Local | Delete file or run uninstall with purge |
| Logs (`daemon-python/logs`) | 30 days recommended | Local | Remove files; log rotation snippet in FAILSAFE |
| Crash reports | 30 days recommended | Local | Delete `daemon-python/crash_reports` |
| Screenshots | User-managed | Local | Delete `daemon-python/screenshots` |
| Telemetry ID | Persistent until telemetry disabled | Local | Delete `daemon-python/telemetry` |
| Backups | User-managed | Local `backups/` | Delete archives you no longer need |

### Deletion Requests
- All data is local-first; users control deletion directly on disk.
- Backend deployments: database owners are responsible for honoring deletion requests (not ARCANOS project).

---

## 🛡️ Security Features

### Implemented Protections

#### 1. Command Execution Safety
```python
# Dangerous commands blocked by default
dangerous_commands = [
    "rm -rf", "del /f", "format", "diskpart",
    "reg delete", "shutdown", "cipher /w"
]
```

#### 2. API Validation
```typescript
// Backend validates all inputs
if (!message || !response) {
    return res.status(400).json({ error: 'Bad Request' });
}
```

#### 3. Rate Limiting
```python
# Local rate limits
MAX_REQUESTS_PER_HOUR = 60
MAX_TOKENS_PER_DAY = 100000
MAX_COST_PER_DAY = 10.0

# Backend rate limits (per IP)
100 requests per 15 minutes
```

#### 4. JWT Authentication
```typescript
// All backend endpoints require valid JWT
app.use('/api/ask', authenticateJWT, askRoute);
```

#### 5. SQL Injection Prevention
```typescript
// Parameterized queries only
await query('INSERT INTO conversations VALUES ($1, $2)', [userId, message]);
```

#### 6. Security Headers (Helmet)
- XSS Protection
- Clickjacking Prevention
- HSTS Enforcement
- Content Security Policy

---

## 🚨 Vulnerability Reporting

### Responsible Disclosure

If you discover a security vulnerability, please follow these steps:

1. **DO NOT** open a public GitHub issue
2. **Report via:** 
   - GitHub Security Advisories (preferred): https://github.com/pbjustin/Arcanos/security/advisories/new
   - Or email: security@arcanos.example.com (if contact available)
3. **Include:**
   - Description of vulnerability
   - Steps to reproduce
   - Affected versions
   - Suggested fix (if any)
   - Impact assessment (e.g., credential exposure, RCE, data breach)

### Response Timeline

- **< 24 hours:** Acknowledgment of report
- **< 7 days:** Initial assessment and severity rating
- **< 30 days:** Fix developed and tested
- **< 45 days:** Security advisory published (if critical)

### Severity Levels

| Level | Description | Response Time |
|-------|-------------|---------------|
| 🔴 **Critical** | Remote code execution, API key theft | < 24 hours |
| 🟠 **High** | Privilege escalation, data breach | < 7 days |
| 🟡 **Medium** | DoS, information disclosure | < 30 days |
| 🟢 **Low** | Minor issues, best practice violations | < 90 days |

---

## ✅ Security Best Practices

### For Users

1. **Protect Your API Key**
   - Never share your OpenAI API key
   - Don't commit `.env` to Git
   - Rotate keys if suspected compromise

2. **Review Terminal Commands**
   - Check what commands ARCANOS suggests before running
   - Keep command blacklist enabled
   - Don't disable safety features unless necessary

3. **Keep Software Updated**
   - Update ARCANOS regularly
   - Update Python and dependencies
   - Monitor GitHub releases for security patches

4. **Secure Your Machine**
   - Use Windows firewall
   - Keep antivirus updated
   - Use strong Windows account password

5. **Backup Carefully**
   - Encrypt backups of `memories.json`
   - Don't store backups in public locations
   - Delete old backups securely

### For Developers

1. **Code Review**
   - All PRs require review
   - Security-sensitive changes need extra scrutiny
   - Use GitHub CodeQL scanning

2. **Dependency Management**
   ```powershell
   # Check for vulnerabilities
   pip-audit
   npm audit
   ```

3. **Secrets in CI/CD**
   - Use GitHub Secrets for sensitive values
   - Never log secrets in CI output
   - Rotate secrets on employee departure

4. **Testing**
   - Write security tests for input validation
   - Test rate limiting and authentication
   - Fuzz test API endpoints

---

## 📋 Security Checklist

Before deploying ARCANOS:

### Credentials & Secrets
- [ ] `.env` file not committed to Git (check `.gitignore`)
- [ ] `.env.example` contains no real secrets (only placeholders)
- [ ] API keys rotated and secure
- [ ] `DEBUG_SERVER_TOKEN` set and secure (generate with `secrets.token_urlsafe(32)`)
- [ ] Backend JWT verification keys configured (if backend used)
- [ ] Database credentials secure (if backend deployed)

### Transport Security
- [ ] Backend URL uses `https://` (or `BACKEND_ALLOW_HTTP=true` only for localhost/dev)
- [ ] Backend HTTPS enforcement enabled (default)
- [ ] Debug server bound to `127.0.0.1` only (not exposed to network)

### Authentication & Authorization
- [ ] Backend JWT verification enabled (if backend used)
- [ ] Debug server authentication enabled (`DEBUG_SERVER_TOKEN` set)
- [ ] Query parameter auth disabled (`DEBUG_SERVER_ALLOW_QUERY_TOKEN=false`)
- [ ] Unauthenticated access disabled (`DEBUG_SERVER_ALLOW_UNAUTHENTICATED=false`)

### Rate Limiting & DoS Protection
- [ ] Debug server rate limiting enabled (`DEBUG_SERVER_RATE_LIMIT` configured)
- [ ] Local rate limits configured appropriately
- [ ] Backend rate limiting enabled (if backend deployed)

### Command Execution Safety
- [ ] Command blacklist enabled
- [ ] Dangerous commands blocked (`ALLOW_DANGEROUS_COMMANDS=false`)
- [ ] Command execution audit logging enabled (logs command hash, not raw command)
- [ ] Sensitive action confirmation enabled (`CONFIRM_SENSITIVE_ACTIONS=true`)

### Logging & Monitoring
- [ ] Telemetry consent obtained (if enabled)
- [ ] Logs don't contain secrets (redaction enabled)
- [ ] Auth failures logged (without tokens)
- [ ] Command execution attempts logged (hash only)

### System Security
- [ ] File permissions correct on `memories.json` and `.env`
- [ ] Windows Defender/antivirus not blocking
- [ ] SQL queries parameterized (if backend deployed)
- [ ] User input sanitized

---

## 🔗 Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Python Security Best Practices](https://python.readthedocs.io/en/stable/library/security_warnings.html)
- [Node.js Security Checklist](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
- [OpenAI API Best Practices](https://platform.openai.com/docs/guides/safety-best-practices)

---

## 📜 License & Intellectual Property

### User Data Ownership

**You own your data.** ARCANOS does not claim any rights to:
- Your conversations with the AI
- Your screenshots or camera captures
- Your terminal command history
- Your preferences and settings

See [LICENSE](LICENSE) for full terms.

---

## 📊 Security Metrics

We track (anonymously, if telemetry enabled):
- Number of blocked dangerous commands
- Rate limit violations
- Authentication failures (backend)
- Crash frequency

We **DO NOT** track:
- Conversation content
- API keys or secrets
- Personal information
- File paths or system details

---

**Last Updated:** January 18, 2026  
**Version:** 1.0.0

For questions: security@arcanos.example.com

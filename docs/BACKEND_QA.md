# 🔐 Backend Security & Architecture Questions

## Answered Questions

### Q1: Should memory state be treated as user IP (exclude from open license)?

**Answer: YES - User data is separate from software license**

**Clarification added to LICENSE:**
- User-generated memory state (`memories.json`) is **YOUR intellectual property**
- It is **NOT** covered by the MIT software license
- The MIT license covers the **code**, not the **data**

**Implications:**
```
┌─────────────────────────────────────────┐
│ MIT License Covers:                     │
│ ✅ ARCANOS source code                  │
│ ✅ Build scripts                        │
│ ✅ Documentation                        │
│ ✅ Backend API code                     │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ User Owns (NOT under MIT):              │
│ ✅ Conversations in memories.json       │
│ ✅ Screenshots captured                 │
│ ✅ User preferences/settings            │
│ ✅ Backend database records             │
└─────────────────────────────────────────┘
```

**Recommended User Actions:**
- Encrypt sensitive conversations
- Do not share `memories.json` publicly
- Back up with separate license terms
- Consider adding user-specific copyright notice

---

### Q2: What's the defined Recovery Time Objective (RTO) for module failure?

**Answer: < 30 seconds for 95% of failures**

**Detailed RTO Matrix** (see [FAILSAFE.md](FAILSAFE.md)):

| Module | Detection | Recovery | Auto/Manual | Data Loss |
|--------|-----------|----------|-------------|-----------|
| Daemon crash | < 1s | < 5s | Auto | None |
| Memory corruption | < 1s | < 10s | Auto | Last session |
| GPT API failure | Instant | 2-10s retry | Auto | None (cached) |
| Vision failure | Instant | Graceful degradation | Auto | None |
| Audio failure | Instant | Text-only mode | Auto | None |
| Terminal failure | Instant | Disable terminal | Auto | None |
| Backend failure | < 5s | Local-only mode | Auto | None |
| Rate limit | Instant | Wait next window | Auto | None (queued) |

**Overall Targets:**
- **Mean Time To Recovery (MTTR):** < 10 seconds
- **Recovery Success Rate:** 95%
- **Automatic Recovery:** 90% of failures
- **Zero Data Loss:** 99% of failures

**Implementation:**
- Auto-restart: Max 5 restarts in 5 minutes (prevents crash loops)
- Graceful degradation: Features disable individually, not entire system
- Memory bootstrapping: Template restores from `bootstrap_template.json`
- Cached responses: 5-minute TTL reduces API dependency

---

### Q3: Will user-contributed skills run sandboxed?

**Answer: FUTURE FEATURE - Not currently implemented, but architecture prepared**

**Current State (v1.0.0):**
- ❌ No plugin system yet
- ❌ No user-contributed skills
- ✅ Terminal commands have security sandbox:
  - Blacklist dangerous commands
  - Whitelist override option
  - No arbitrary code execution

**Planned Architecture (v2.0+):**

```python
# Future plugin system design
class SkillPlugin:
    """Base class for user-contributed skills"""
    
    def __init__(self):
        self.sandbox = Sandbox(
            allowed_modules=['requests', 'json'],
            filesystem_access='read-only',
            network_access='restricted',
            max_execution_time=5.0,
            max_memory_mb=100
        )
    
    def execute(self, context: dict) -> dict:
        """Run skill in sandboxed environment"""
        return self.sandbox.run(self.skill_code, context)
```

**Sandbox Constraints (Planned):**

| Resource | Limit | Rationale |
|----------|-------|-----------|
| CPU Time | 5 seconds | Prevent infinite loops |
| Memory | 100 MB | Prevent memory exhaustion |
| Network | Whitelist only | Prevent data exfiltration |
| File System | Read-only | Prevent system modification |
| Subprocess | Blocked | Prevent privilege escalation |
| Imports | Whitelist only | Prevent malicious modules |

**Security Model:**
1. **Isolation:** Plugins run in separate process
2. **Permission System:** Explicit user approval for each capability
3. **Code Review:** Community-reviewed plugins only in "official" repo
4. **Signed Plugins:** Cryptographic signatures required
5. **Audit Log:** All plugin actions logged

**Example Permission Request:**
```
Plugin "GitHub Integration" requests:
  ✅ Network access to github.com
  ✅ Read file system (current directory only)
  ❌ Write file system
  ❌ Terminal command execution
  
[Allow Once] [Allow Always] [Deny]
```

**Implementation Timeline:**
- **v1.0** (Current): No plugins, terminal sandbox only
- **v1.5** (Q2 2026): Plugin API design, basic sandboxing
- **v2.0** (Q3 2026): Full plugin marketplace with security review

**Why Not Now?**
- Security risk too high for v1.0
- Need community testing of core features first
- Architecture must be battle-tested before exposing plugin API

---

## Additional Backend Considerations

### Database Security

**Current:**
- PostgreSQL with parameterized queries (SQL injection prevention)
- JWT authentication on all endpoints
- Rate limiting per IP (100 req/15min)
- TLS encryption in transit (Railway default)

**Planned:**
- Encryption at rest (AES-256)
- Automatic backup rotation
- Anomaly detection for unusual access patterns
- Multi-region redundancy

### API Rate Limiting Strategy

**Current Limits:**
```
Local (Per User):
├─ 60 requests/hour
├─ 100,000 tokens/day
└─ $10.00 cost/day

Backend (Per IP):
├─ 100 requests/15min
└─ Exponential backoff on violations
```

**Why These Limits?**
- Prevents accidental API key abuse
- Protects against malicious users
- Keeps costs predictable
- Balances usability with safety

### Backend Failure Modes

**Scenario 1: Backend Unavailable**
- Daemon switches to local-only mode
- All features continue working
- Conversations saved locally
- Sync resumes when backend returns

**Scenario 2: Database Full**
- Backend returns 507 Insufficient Storage
- Daemon stops syncing (logs warning)
- Local operation unaffected
- Admin notified to upgrade storage

**Scenario 3: JWT Compromise**
- Rotate JWT secret immediately
- All users re-authenticate
- Audit logs analyzed for breach
- Incident report generated

---

## Recommendations

### For Users

1. **Treat `memories.json` as private data**
   - Encrypt before cloud backup
   - Do not share publicly
   - Add to .gitignore (already done)

2. **Monitor your costs**
   - Use `stats` command regularly
   - Set alerts on OpenAI dashboard
   - Adjust rate limits if needed

3. **Keep backups**
   - Weekly automated backups
   - Test restore procedure
   - Store encrypted offsite

### For Contributors

1. **Security-first development**
   - All PRs reviewed for security
   - No secrets in commits
   - Dependency scanning (pip-audit, npm audit)

2. **Test failure scenarios**
   - Simulate crashes, network failures
   - Verify graceful degradation
   - Measure actual RTO

3. **Document everything**
   - Security model in SECURITY.md
   - Recovery in FAILSAFE.md
   - Architecture in ARCHITECTURE.md

---

**Last Updated:** January 18, 2026  
**Version:** 1.0.0

For additional questions: architecture@arcanos.example.com

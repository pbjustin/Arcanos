## 🚀 QUICK REFERENCE CARD
### Essential Commands and Endpoints

**BASIC SETUP:**
```bash
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos && npm install && npm run build && npm start
```

**KEY ENDPOINTS:**
- Health: `GET /health`
- API Status: `GET /api`
- Main ARCANOS: `POST /api/ask`
- Memory: `GET/POST /api/memory`
- Canon Files: `GET/POST /api/canon/files/{filename}`
- Worker Status: `GET /api/booker/workers/status`

**CUSTOM GPT ACTIONS SUMMARY:**
```json
{
  "askArcanos": "POST /api/ask",
  "storeMemory": "POST /api/memory", 
  "getMemories": "GET /api/memory",
  "listCanonFiles": "GET /api/canon/files",
  "readCanonFile": "GET /api/canon/files/{filename}",
  "writeCanonFile": "POST /api/canon/files/{filename}",
  "getWorkerStatus": "GET /api/booker/workers/status"
}
```

**ENVIRONMENT VARIABLES:**
```env
NODE_ENV=production
PORT=8080
OPENAI_API_KEY=your-key-here
OPENAI_FINE_TUNED_MODEL=your-model-id
SESSION_SECRET=your-secret-here
```

**TEST COMMAND:**
```bash
./test-backstage-booker.sh
```

**CANON FILE STRUCTURE:**
```json
{
  "character": {
    "name": "Wrestler Name",
    "brand": "RAW|SmackDown|NXT",
    "alignment": "face|heel|tweener",
    "status": "active|injured|suspended",
    "currentTitles": ["Title Name"],
    "faction": "Faction Name"
  },
  "storylines": {
    "current": [...],
    "completed": [...]
  }
}
```

**TROUBLESHOOTING:**
- Server not starting: Check `npm run build` output
- API errors: Verify OpenAI API key in `.env`
- Canon files not saving: Check `storage/canon/` directory permissions
- Custom GPT not working: Verify deployment URL in action configuration
# ARCANOS Automated Codebase Purification Tool

🧹 **Removes bloat, legacy fragments, and redundancy with AI-driven precision.**

## ⸻ Features

### 🚀 Intelligent Code Pruning
Detects and removes outdated or unused files, functions, and modules using advanced AST analysis.

### 🔄 Redundancy Sweep  
Identifies duplicate logic and consolidates repetitions across the codebase.

### 🛡️ Commit-Safe Operations
Generates clean pull requests with detailed change logs. Dry-run mode by default for safety.

### ⚙️ Configurable Ruleset
Tune cleaning parameters via `codex.config.json` with granular control over thresholds and behavior.

## ⸻ AI Backbone

### 🧠 Powered by OpenAI
Integrates seamlessly with the existing OpenAI SDK service for intelligent code analysis.

### 🚄 Railway-Ready
Includes `railway.json` for deployment scaffolding and environment variable templating (`OPENAI_API_KEY`, `PROJECT_ENV`).

## ⸻ Quick Start

### 1. Configuration
The tool uses `codex.config.json` for configuration:

```json
{
  "purification": {
    "enabled": true,
    "scanners": {
      "deadCode": {
        "enabled": true,
        "thresholds": {
          "largeFileLines": 500,
          "maxConsoleLogsPerFile": 3,
          "maxFunctionLines": 50
        },
        "supportedExtensions": [".py", ".js", ".ts", ".jsx", ".tsx", ".go"]
      }
    },
    "ai": {
      "model": "gpt-4-turbo",
      "useExistingService": true
    },
    "safety": {
      "dryRunByDefault": true,
      "requireConfirmation": true
    }
  }
}
```

### 2. Run the Demo
```bash
npm run purify:demo
```

### 3. Start the Server
```bash
npm start
```

## ⸻ API Endpoints

### 🔍 Scan Codebase
```bash
curl -X POST -H "Content-Type: application/json" \
     -H "x-confirmed: yes" \
     -d '{"targetPath": "./src"}' \
     http://localhost:8080/purify/scan
```

### 🤖 AI Analysis
```bash
curl -X POST -H "Content-Type: application/json" \
     -H "x-confirmed: yes" \
     -d '{
       "code": "function unusedFunction() { return 42; }",
       "analysisType": "review"
     }' \
     http://localhost:8080/purify/analyze
```

### 📊 Service Status
```bash
curl http://localhost:8080/purify/status
```

### ⚙️ Get Configuration
```bash
curl http://localhost:8080/purify/config
```

### ✅ Apply Recommendations (Dry Run)
```bash
curl -X POST -H "Content-Type: application/json" \
     -H "x-confirmed: yes" \
     -d '{
       "recommendations": [...],
       "dryRun": true
     }' \
     http://localhost:8080/purify/apply
```

## ⸻ Python Scanner

### Direct Usage
```bash
# Full scan
python3 dead_code_scanner.py

# Test mode (limited files)
python3 dead_code_scanner.py --test

# Custom directory
python3 dead_code_scanner.py ./src
```

### NPM Script
```bash
npm run purify:scan
```

## ⸻ Integration with ARCANOS

### ✅ Existing Service Integration
- Uses existing OpenAI service (no duplication)
- Integrates with PR Assistant workflow  
- Follows existing validation and security patterns
- Comprehensive logging with structured logger

### 🔧 Route Integration
The purification endpoints are automatically registered under `/purify/*`:
- Uses existing middleware (validation, rate limiting, confirmation gates)
- Consistent error handling and response formatting
- Full TypeScript support with proper type definitions

### 🧪 Testing
Comprehensive test suite included:
```bash
npm test  # Includes purification tests
```

## ⸻ Safety Features

### 🛡️ Default Safety Mode
- **Dry-run by default**: All operations are simulated unless explicitly confirmed
- **Backup creation**: Automatic backups before any file modifications
- **Confidence thresholds**: Low-confidence recommendations are skipped
- **User confirmation**: Requires explicit confirmation headers for destructive operations

### 📊 Detailed Reporting
- **Change logs**: Comprehensive markdown reports of all proposed changes
- **Impact analysis**: Metrics on potential lines/files saved
- **Issue classification**: Severity levels for different types of problems
- **Recommendation confidence**: AI-powered confidence scores for each suggestion

## ⸻ Deployment

### Railway Configuration
The tool is fully Railway-ready:
- Environment variables properly configured
- Health check endpoints available
- Graceful degradation without API keys
- Proper error handling and logging

### Environment Variables
```bash
OPENAI_API_KEY=your-openai-key          # For AI analysis
PROJECT_ENV=production                   # Deployment environment  
ARCANOS_MAINTENANCE_AGENT=assistant-id  # Optional AI agent integration
```

## ⸻ Development

### Architecture
- **CodebasePurifier**: Main service class for purification operations
- **Dead Code Scanner**: Multi-language AST-based analysis (Python, JS/TS)
- **API Routes**: RESTful endpoints with proper validation
- **Configuration System**: JSON-based configuration with defaults

### Adding New Scanners
1. Implement scanner in appropriate language (Python for AST, JS/TS for complex logic)
2. Add configuration options in `codex.config.json`
3. Update the `CodebasePurifier` service to integrate the new scanner
4. Add appropriate tests and documentation

### Contributing
- Follow existing code style and patterns
- Add tests for new features
- Update configuration documentation
- Ensure Railway deployment compatibility

---

🎯 **Ready to purify your codebase!** Start with `npm run purify:demo` to see it in action.
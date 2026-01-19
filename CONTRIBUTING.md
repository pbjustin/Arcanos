# Contributing to ARCANOS

Thank you for your interest in contributing to ARCANOS! This document provides guidelines and instructions for contributing.

## 🚀 Getting Started

### Prerequisites
- Windows 10/11
- Python 3.11+
- Node.js 18+
- Git
- VS Code (recommended)

### Development Setup

1. **Fork and clone**:
```bash
git clone https://github.com/yourusername/arcanos-hybrid.git
cd arcanos-hybrid
```

2. **Python daemon setup**:
```bash
cd daemon-python
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt
```

3. **TypeScript backend setup**:
```bash
cd backend-typescript
npm install
```

4. **Create `.env` file**:
```bash
cp daemon-python/.env.example daemon-python/.env
# Add your OPENAI_API_KEY
```

## 🏗️ Project Structure

```
arcanos-hybrid/
├── daemon-python/          # Main Python daemon
│   ├── cli.py              # CLI interface
│   ├── gpt_client.py       # OpenAI integration
│   ├── vision.py           # Screen/camera capture
│   ├── audio.py            # Speech recognition/TTS
│   ├── terminal.py         # Command execution
│   ├── push_to_talk.py     # PTT system
│   ├── config.py           # Configuration
│   ├── schema.py           # Data models
│   ├── error_handler.py    # Error handling
│   ├── rate_limiter.py     # Rate limiting
│   └── ...
├── backend-typescript/     # Express backend
│   ├── src/
│   │   ├── index.ts        # Server entry
│   │   ├── database.ts     # PostgreSQL
│   │   ├── auth.ts         # JWT auth
│   │   └── routes/         # API routes
│   └── package.json
├── tests/                  # Test suites
├── scripts/                # Build/deploy scripts
└── docs/                   # Documentation
```

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

### Write new tests:
- Python: Add to `tests/test_*.py`
- TypeScript: Add to `src/__tests__/*.test.ts`

## 💻 Code Style

### Python
- **Formatter**: Black
- **Linter**: Flake8
- **Type hints**: Required for all functions

```bash
black daemon-python/
flake8 daemon-python/
mypy daemon-python/
```

### TypeScript
- **Formatter**: Prettier
- **Linter**: ESLint
- **Style**: Airbnb config

```bash
npm run format
npm run lint
```

## 📝 Commit Guidelines

Use conventional commits:

```
feat: add voice activity detection to PTT
fix: resolve crash when API key missing
docs: update installation instructions
test: add unit tests for rate limiter
refactor: simplify error handling logic
style: format code with black
chore: update dependencies
```

## 🔀 Pull Request Process

1. **Create feature branch**:
```bash
git checkout -b feature/your-feature-name
```

2. **Make changes**:
   - Write code
   - Add tests
   - Update documentation

3. **Run quality checks**:
```bash
# Python
black daemon-python/
flake8 daemon-python/
pytest tests/ -v

# TypeScript
npm run lint
npm run format
npm test
```

4. **Commit and push**:
```bash
git add .
git commit -m "feat: your feature description"
git push origin feature/your-feature-name
```

5. **Create Pull Request**:
   - Fill out PR template
   - Link related issues
   - Request review

### PR Requirements
- ✅ All tests passing
- ✅ Code formatted
- ✅ No linter errors
- ✅ Documentation updated
- ✅ Changelog entry added

## 🐛 Bug Reports

Use GitHub Issues with the bug report template:

```markdown
**Describe the bug**
A clear description of the bug.

**To Reproduce**
Steps to reproduce:
1. Run command '...'
2. Click on '...'
3. See error

**Expected behavior**
What should happen.

**Screenshots**
If applicable.

**Environment**
- OS: Windows 11
- Python: 3.11.5
- ARCANOS: v1.0.0
```

## ✨ Feature Requests

Use GitHub Issues with the feature request template:

```markdown
**Is your feature request related to a problem?**
Clear description of the problem.

**Describe the solution**
What you'd like to happen.

**Alternatives considered**
Other solutions you've considered.

**Additional context**
Any other context or screenshots.
```

## 📚 Documentation

Update documentation when:
- Adding new features
- Changing APIs
- Modifying configuration
- Adding dependencies

Documentation locations:
- `README.md`: User-facing docs
- `docs/`: Detailed guides
- Docstrings: Code documentation
- `CONTRIBUTING.md`: This file

## 🔐 Security

Report security vulnerabilities privately:
- Email: security@arcanos.example.com
- Do NOT create public issues

## 🎯 Areas to Contribute

### High Priority
- [ ] Auto-start on Windows login
- [ ] Settings UI (web dashboard)
- [ ] Plugin system
- [ ] Multi-language support
- [ ] Performance optimizations

### Good First Issues
- [ ] Add more unit tests
- [ ] Improve error messages
- [ ] Add logging to modules
- [ ] Update documentation
- [ ] Fix typos

### Advanced
- [ ] WebSocket support
- [ ] Custom model integration
- [ ] Browser extension
- [ ] Mobile app companion

## 🏆 Recognition

Contributors will be:
- Listed in `README.md`
- Mentioned in release notes
- Invited to contributor Discord

## 📞 Questions?

- **Discord**: [Join our server](https://discord.gg/arcanos)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/arcanos-hybrid/discussions)
- **Email**: contributors@arcanos.example.com

## 📜 Code of Conduct

Be respectful, inclusive, and professional. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

---

Thank you for contributing to ARCANOS! 🌌

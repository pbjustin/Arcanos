# Contributing to Arcanos Backend

Welcome to the Arcanos project! We appreciate your interest in contributing to this AI-controlled TypeScript backend. This guide will help you get started with development and ensure your contributions align with our project standards.

## 🚀 Getting Started

### Prerequisites
- **Node.js 18+** (check with `node --version`)
- **npm 8+** (check with `npm --version`)
- **PostgreSQL** (optional - system uses in-memory fallback)
- **OpenAI API Key** (for AI functionality testing)
- **Git** for version control

### Development Setup

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/yourusername/Arcanos.git
   cd Arcanos
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration (see Environment Variables section)
   ```

4. **Build and test**
   ```bash
   npm run build
   npm test
   npm run lint
   ```

5. **Start development server**
   ```bash
   npm run dev
   ```

## 🏗️ Development Workflow

### Code Style & Standards

#### TypeScript Guidelines
- Use **strict TypeScript** - no `any` types without justification
- Implement proper **error handling** with try-catch blocks
- Use **async/await** over promises where possible
- Follow **interface-first** design for type definitions
- Add **JSDoc comments** for public functions and complex logic

#### Code Organization
- Place **route handlers** in `src/routes/`
- Put **business logic** in `src/services/`
- Keep **AI reasoning** in `src/logic/`
- Store **utilities** in `src/utils/`
- Define **types** in `src/types/`

#### Naming Conventions
- Use **camelCase** for variables and functions
- Use **PascalCase** for classes and interfaces
- Use **kebab-case** for file names
- Use **UPPER_SNAKE_CASE** for environment variables

### Testing Requirements

#### Unit Tests
- Write tests for all new services and utilities
- Place tests in `tests/` directory
- Use descriptive test names: `should return valid response when API key is provided`
- Test both success and failure cases
- Mock external dependencies (OpenAI, databases)

#### Integration Tests
- Test API endpoints with actual HTTP requests
- Verify middleware functionality (validation, confirmation gates)
- Test memory system operations
- Ensure worker system initialization

#### Running Tests
```bash
npm test                 # Run all tests
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests only
npm run type-check       # TypeScript compilation check
```

### Git Workflow

#### Branch Naming
- `feature/description` - New features
- `fix/description` - Bug fixes  
- `docs/description` - Documentation updates
- `refactor/description` - Code improvements

#### Commit Messages
Follow conventional commits format:
```
type(scope): description

Examples:
feat(api): add HRC endpoint for hallucination resistance
fix(memory): resolve PostgreSQL connection timeout
docs(readme): update API endpoint documentation
refactor(services): simplify OpenAI client initialization
```

#### Pull Request Process
1. Create feature branch from `main`
2. Make changes with tests
3. Run full test suite and linting
4. Update documentation if needed
5. Submit PR with descriptive title and details
6. Address review feedback promptly

## 🧠 AI System Architecture

### Core Concepts

#### Fine-tuned Model Integration
- System uses `REDACTED_FINE_TUNED_MODEL_ID` as primary model
- Fallback to GPT-4-turbo for complex operations
- Mock responses in development when API key unavailable

#### Memory System
- **Primary**: PostgreSQL with automatic schema management
- **Fallback**: In-memory storage for development
- **Types**: Context, facts, preferences, decisions, patterns
- **Session Management**: Dual-mode conversation storage

#### Worker System
- **AI-Controlled**: CRON jobs managed by AI decisions
- **Dynamic Loading**: Workers loaded from filesystem at startup
- **Health Monitoring**: Automatic status reporting and recovery

### Adding New Features

#### API Endpoints
1. Create route handler in `src/routes/`
2. Add validation middleware if needed
3. Implement confirmation gate for sensitive operations
4. Register route in `src/routes/register.ts`
5. Add tests and documentation

#### AI Services
1. Implement in `src/services/` with proper error handling
2. Use circuit breaker pattern for external API calls
3. Add memory-aware context when applicable
4. Include mock responses for development
5. Test with and without OpenAI API key

#### Workers
1. Create worker file following established patterns
2. Include proper error handling and logging
3. Implement health check functionality
4. Add to worker initialization system
5. Test scheduling and execution

## 📝 Documentation Standards

### Code Documentation
- **JSDoc** for all public functions
- **Inline comments** for complex logic
- **Type annotations** for all parameters and returns
- **Error documentation** for possible exceptions

### API Documentation  
- Update README.md for new endpoints
- Include request/response examples
- Document required headers (confirmation, etc.)
- Specify authentication requirements

### Changelog Updates
- Add entries for all user-facing changes
- Follow semantic versioning principles
- Include migration notes for breaking changes
- Reference issue/PR numbers

## 🔧 Environment Variables

### Required for Development
```bash
OPENAI_API_KEY=your-key-here  # Essential for AI functionality
NODE_ENV=development          # Enables dev features
PORT=8080                     # Development server port
```

### Optional but Recommended
```bash
DATABASE_URL=postgresql://...  # For persistent storage testing
RUN_WORKERS=true              # Enable background worker testing
ARC_LOG_PATH=/tmp/arc/log     # Custom log directory
```

### Testing Configuration
```bash
# Use different values for testing
PORT=3000
NODE_ENV=test
DATABASE_URL=postgresql://test_user:test_pass@localhost:5432/arcanos_test
```

## 🐛 Bug Reports & Issues

### Before Submitting
1. Check existing issues for duplicates
2. Test with latest `main` branch
3. Gather relevant logs and error messages
4. Include reproduction steps

### Issue Template
```
**Bug Description**
Clear description of the issue

**Steps to Reproduce**
1. Step one
2. Step two
3. Expected vs actual behavior

**Environment**
- Node.js version:
- npm version:
- Operating system:
- Branch/commit:

**Logs**
```
Relevant log output
```
```

## 🚀 Feature Requests

### Proposal Format
- **Problem**: What issue does this solve?
- **Solution**: Proposed implementation approach
- **Impact**: Who benefits and how?
- **Complexity**: Development effort estimate
- **Alternatives**: Other approaches considered

### Implementation Guidelines
- Start with GitHub issue for discussion
- Consider backward compatibility
- Plan testing strategy
- Update documentation
- Consider performance implications

## 💡 Best Practices

### Security
- **Never commit** API keys or secrets
- **Validate all inputs** from external sources
- **Use confirmation gates** for destructive operations
- **Sanitize outputs** before returning to clients
- **Implement rate limiting** for public endpoints

### Performance
- **Cache responses** when appropriate
- **Use circuit breakers** for external API calls
- **Implement connection pooling** for databases
- **Monitor memory usage** in long-running processes
- **Optimize TypeScript compilation** for production

### AI Integration
- **Handle API failures** gracefully with fallbacks
- **Implement retry logic** with exponential backoff
- **Use memory context** for conversation continuity
- **Respect rate limits** and usage guidelines
- **Test with mock responses** during development

## 📞 Getting Help

### Community Support
- **GitHub Discussions** for general questions
- **GitHub Issues** for bugs and feature requests
- **Code Reviews** for implementation feedback

### Development Resources
- **TypeScript Documentation**: https://www.typescriptlang.org/docs/
- **Express.js Guide**: https://expressjs.com/en/guide/
- **OpenAI API Reference**: https://platform.openai.com/docs/api-reference
- **Railway Deployment**: https://docs.railway.app/

## 📄 License

By contributing to Arcanos, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Arcanos! Together we're building an advanced AI-controlled backend system. 🤖✨
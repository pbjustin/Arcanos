# Changelog

All notable changes to the Arcanos Backend project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

# Changelog

All notable changes to the Arcanos Backend project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added - Continuous Audit & Refinement Implementation
- **Continuous Audit Script**: Automated codebase auditing script (`scripts/continuous-audit.js`)
  - Phase 1: Dependency pruning and security vulnerability detection
  - Phase 2: Architectural integrity validation and duplicate pattern detection
  - Phase 3: OpenAI SDK compatibility enforcement (v5.16.0+)
  - Phase 4: Railway deployment optimization validation
  - Phase 5: Continuous audit loop with automated reporting
- **New NPM Scripts**: 
  - `npm run audit:continuous` - Run automated audit checks
  - `npm run audit:full` - Complete audit including lint, type-check, tests, and continuous audit
- **Consolidated Fallback System**: Enhanced middleware-based fallback handling with comprehensive degraded mode support

### Changed - Architectural Consolidation
- **Dependency Optimization**: Updated axios to latest version (fixed DoS vulnerability)
- **Module Consolidation**: Removed duplicate fallback handlers and memory route implementations
- **Route Optimization**: Consolidated `src/routes/memory.ts` into `src/routes/api-memory.ts`
- **Jest Configuration**: Enhanced TypeScript transpilation support with proper ESM handling
- **Import Cleanup**: Removed unused imports and consolidated duplicate service patterns

### Removed - Aggressive Pruning
- **Unused Dependencies**: Removed chokidar, express-rate-limit, and sqlite3 (not used in current implementation)
- **Duplicate Files**: 
  - `src/services/fallbackHandler.ts` (consolidated into middleware)
  - `src/routes/memory.ts` (functionality preserved in api-memory.ts)
- **Dead Code**: Eliminated unused exports and redundant logic patterns

### Fixed - Quality & Security
- **Security Vulnerabilities**: Fixed high-severity axios DoS vulnerability (GHSA-4hjh-wcwx-xvwj)
- **Test Compilation**: Fixed TypeScript compilation errors in test files
- **Import Dependencies**: Added missing @jest/globals dependency
- **Module Boundaries**: Cleaned up cross-module import violations
- **OpenAI SDK Compatibility**: Validated all OpenAI integrations use current v5.x patterns

### Operational Excellence
- **Zero Unused Dependencies**: Achieved clean dependency audit with no unused packages
- **100% Test Pass Rate**: All 29 tests passing with improved TypeScript support
- **Enhanced Railway Compatibility**: Validated deployment configuration and health checks
- **Automated Quality Gates**: Continuous audit system ensures ongoing codebase health

### Documentation
- Updated README and documentation index to reflect current scripts and mounted routes.
- Removed the duplicate `docs/CHANGELOG.md` in favor of the canonical root changelog.

### Added - Previous Changes
- Comprehensive documentation audit and update following CLEAR 2.0 standards
- CONTRIBUTING.md with detailed development guidelines and best practices
- Enhanced .env.example with categorized configuration sections and detailed descriptions
- Updated API endpoint documentation reflecting current system capabilities

### Changed - Previous Changes
- README.md restructured with current feature accuracy and improved organization
- Environment variable documentation with comprehensive descriptions and examples
- Project structure documentation updated to reflect actual codebase organization

### Fixed - Previous Changes
- Corrected outdated API endpoint references in documentation
- Fixed inconsistencies between code implementation and documentation
- Updated dependency versions in documentation to match package.json

## [1.4.4] - 2024-09-04

### Fixed
- Accept `RAILWAY_ENVIRONMENT` values containing `-pr-` to support project-prefixed preview deployments

## [1.4.3] - 2024-09-04

### Fixed
- Allow `RAILWAY_ENVIRONMENT` values that start with `pr-` for preview deployments
- Added missing `zod` dependency to prevent runtime crashes

## [1.4.2] - 2024-03-14

### Changed
- HRCCore now uses your fine-tuned model by default and allows override via `HRC_MODEL` environment variable

## [1.4.1] - 2024-03-14

### Added
- Implemented Hallucination-Resistant Core with OpenAI SDK integration
- Exposed `/api/ask-hrc` endpoint for resilience and fidelity scoring

## [1.4.0] - 2024-01-26

### Major Documentation Overhaul
- **Complete README.md restructure**: Reduced from 600+ to ~370 lines while maintaining comprehensive information
- **Enhanced API documentation**: Current endpoint structure with confirmation requirements
- **Streamlined setup process**: Clear 4-step installation guide with environment configuration
- **Modern documentation structure**: Organized sections with improved navigation and examples

### System State Documentation
- **Current architecture**: TypeScript Express.js backend with OpenAI SDK v5.16.0
- **Active fine-tuned model**: `ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH`
- **Memory system**: PostgreSQL primary with in-memory fallback and dual-mode conversation storage
- **Worker system**: AI-controlled CRON scheduling with dynamic loading and health monitoring
- **HRC integration**: Hallucination-Resistant Core for improved AI reliability

### Security & Compliance
- **Confirmation headers**: `x-confirmed: yes` required for sensitive operations
- **Protected endpoints**: Data modification, worker execution, system control, AI processing with side effects
- **Safe endpoints**: Read operations, diagnostics, primary AI interaction
- **Comprehensive error handling**: Graceful fallbacks and circuit breaker patterns

### Developer Experience
- **TypeScript-first**: Strict typing throughout codebase with proper error handling
- **Clear project structure**: Logical module organization with detailed file structure documentation
- **Development tools**: Hot reload, type checking, comprehensive test suite
- **Contributing guidelines**: Detailed best practices guide for system extension and collaboration

## [1.3.0] - 2024-01-26

### Features
- **HRC overlay evaluation**: Runtime scoring system for message quality and hallucination resistance
- **Enhanced environment variables**: Flexible model configuration precedence and comprehensive options
- **Improved OpenAI integration**: Better configuration options, error handling, and fallback mechanisms

### Documentation
- **Cross-linking improvements**: Better navigation between related documentation files
- **Standardized examples**: Consistent code formatting and verified working examples
- **Updated environment docs**: Current precedence rules and configuration options with examples

## [1.2.0] - 2024-07-24

### Major Cleanup
- **Documentation overhaul**: Removed 10+ outdated files and consolidated information
- **AI-controlled system**: Full documentation of operational control and decision-making processes
- **Worker scheduling**: AI-controlled CRON with approval system and health monitoring
- **Memory system**: PostgreSQL backend with automatic snapshots and session management

### Features
- **OpenAI Assistants**: Automatic sync every 30 minutes with error handling
- **Health monitoring**: AI-controlled health checks every 15 minutes with status reporting
- **Maintenance protocols**: Automated maintenance every 6 hours with logging
- **Sleep/wake cycles**: Configurable low-power operation periods for resource optimization

### Removed
- Obsolete audit summaries and implementation reports
- Deprecated Backstage Booker functionality
- Outdated test scripts and client-side code
- Redundant configuration files and unused dependencies

## [1.1.0] - 2024-06-15

### Backend Refactoring
- **OpenAI SDK modernization**: Upgraded to v4.104.0 with modern patterns and streaming support
- **Unified service architecture**: Centralized OpenAI operations with consistent error handling
- **Worker optimization**: 67% reduction in code duplication through modular design
- **Enhanced error handling**: Consistent patterns with proper fallbacks and circuit breakers

### Architecture
- **Modular design**: Improved separation of concerns with clear service boundaries
- **TypeScript enhancement**: Strict typing throughout with comprehensive type definitions
- **Performance features**: Streaming, function calling, circuit breakers, and connection pooling
- **Memory optimization**: Request tracking and connection pooling for improved performance

## [1.0.0] - 2024-05-01

### Initial Release
- **TypeScript backend**: Express.js server with modern architecture and strict typing
- **OpenAI integration**: Fine-tuned model support with intelligent fallbacks
- **Memory system**: Persistent storage with PostgreSQL and in-memory fallback
- **Worker system**: Background task management with AI-controlled scheduling
- **API design**: RESTful endpoints with intelligent routing and validation

### Core Features
- AI-controlled operations with fine-tuned model integration
- Memory-aware reasoning with context preservation
- Intent-based routing with confirmation requirements
- Health monitoring with automatic recovery
- Configuration management with environment-based setup

---

## Legacy Versions

Prior to v1.0.0, the system existed in various development iterations with JavaScript implementations. The v1.0.0 release marked the consolidation to the current TypeScript architecture with comprehensive AI integration.

---

For detailed technical documentation, see the `/docs` directory and CONTRIBUTING.md for development guidelines.
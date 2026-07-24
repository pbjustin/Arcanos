# Changelog

Notable release-facing changes are recorded here. Detailed implementation and
audit history remains available in Git and under `docs/audits/`. The structure
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) where practical.

## [Unreleased]

### Changed

- Consolidated duplicate quickstart, compatibility, CLI, refactor, and
  governance documentation into maintained subsystem owners.
- Replaced the flat documentation reading list with a lifecycle-aware index that
  separates canonical guides, docs-as-contract, design-only material, generated
  indexes, and historical evidence.
- Replaced the Bash-only documentation audit logic with one cross-platform Node
  check exposed as `npm run docs:check`.

### Fixed

- Corrected stale routing, authentication, environment, CLI, MCP, OpenAI,
  self-healing, Railway, and source-path guidance against current code and
  executable configuration.
- Removed an active recommendation to run the unsafe `npm run probe` command.
- Extended documentation validation to check all tracked Markdown link targets
  and require every top-level `docs/*.md` file to appear in the index.

### Removed

- Removed completed migration/refactor notes and the unimplemented async job
  board proposal. The standalone operations dashboard was removed only after
  its implemented metrics, alert, SLO, and replay guidance moved into the
  canonical solo-operator runtime guide.
- Removed standalone micro-guides whose content is now owned by the Python
  daemon or consolidated governance guide.

## 2026-03-03

### Changed

- Updated Railway deployment and health guidance.
- Added Responses API tool-continuation documentation.
- Refreshed local setup and runbook documentation.

[Unreleased]: https://github.com/pbjustin/Arcanos/compare/v1.0.1...HEAD

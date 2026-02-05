# Changelog

## Overview
This project uses a lightweight changelog for release-facing updates. Detailed historical implementation notes were intentionally removed during documentation normalization; older context remains available in git history.

## Prerequisites
- Keep entries factual and tied to merged code.
- Avoid aspirational roadmap statements in release notes.

## Setup
When preparing a release:
1. Add an entry under `Unreleased`.
2. Move it under a version heading at release cut.
3. Include evidence links (PR number or file paths).

## Configuration
Changelog format:
- `Added`, `Changed`, `Fixed`, `Removed`, `Security`
- Keep each bullet concise and user-impact oriented.

## Run locally
No runtime command is required to update this file.

## Deploy (Railway)
Update this changelog in the same PR that changes production behavior or deployment workflow.

## Troubleshooting
If release details are uncertain, add `TODO` and resolve before tagging.

## References
- Keep a Changelog: https://keepachangelog.com/en/1.1.0/
- SemVer: https://semver.org/

## [Unreleased]

### Changed
- Standardized and reduced the documentation set for production use.
- Aligned docs to current OpenAI Node/Python SDK usage and Railway deployment config.

### Removed
- Deleted obsolete audit artifacts, draft PR docs, and legacy/duplicate documentation.

### Fixed
- Corrected stale references to old OpenAI SDK versions and outdated endpoint/header wording.

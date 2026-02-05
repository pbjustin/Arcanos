# Daemon Assets

## Overview
This folder stores packaged daemon assets used by the Python CLI distribution.

## Prerequisites
No runtime prerequisites.

## Setup
Current tracked assets:
- `icon.ico` (application icon)
- `env.example` (packaged env template)

## Configuration
If you replace `icon.ico`, keep `.ico` format compatibility for Windows packaging.

## Run locally
No local execution required for this folder.

## Deploy (Railway)
Not applicable.

## Troubleshooting
If packaged builds miss assets, verify `pyproject.toml` package-data includes this directory.

## References
- `../../pyproject.toml`

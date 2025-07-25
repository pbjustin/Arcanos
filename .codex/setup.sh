#!/bin/bash
# Codex setup script to ensure dependencies for tests
set -e

if [ ! -d node_modules/axios ]; then
  echo "Installing axios for tests"
  npm install axios >/tmp/npm-install.log 2>&1 || {
    echo "Failed to install axios. Check network connectivity.";
    exit 1;
  }
fi

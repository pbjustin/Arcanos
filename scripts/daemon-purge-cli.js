#!/usr/bin/env node
/**
 * CLI Runner for ARCANOS Daemon Purge
 * Usage: node scripts/daemon-purge-cli.js [--dry-run] [--verbose]
 */

import { daemonPurgeCommand } from '../src/commands/arcanos/daemonPurge.js';

const args = process.argv.slice(2);
daemonPurgeCommand(args);

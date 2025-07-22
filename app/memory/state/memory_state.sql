-- Initial schema for modular memory logging
-- This file defines basic tables for goals, identity, and event logs.
-- Compatible with SQLite or PostgreSQL for bootstrapping a local state DB.

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  objective TEXT,
  completed BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS identity (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Log events for each memory module
CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

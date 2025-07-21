-- ARCANOS Universal Memory Archetype Schema
-- Type: Scoped Modular Memory (Railway-Compatible)
-- Purpose: Store and retrieve persistent state per container or service

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Main memory state table
CREATE TABLE IF NOT EXISTS memory_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_key TEXT NOT NULL,
    memory_value JSONB,
    container_id TEXT DEFAULT 'default',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(memory_key, container_id)
);

-- Index for faster key lookups
CREATE INDEX IF NOT EXISTS idx_memory_state_key ON memory_state(memory_key);
CREATE INDEX IF NOT EXISTS idx_memory_state_container ON memory_state(container_id);
CREATE INDEX IF NOT EXISTS idx_memory_state_updated ON memory_state(updated_at);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_memory_state_updated_at ON memory_state;
CREATE TRIGGER update_memory_state_updated_at
    BEFORE UPDATE ON memory_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
-- Memory snapshots schema
CREATE TABLE IF NOT EXISTS memory (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_state (
    id SERIAL PRIMARY KEY,
    key TEXT NOT NULL,
    value JSONB,
    version INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tag TEXT,
    UNIQUE(key, version)
);

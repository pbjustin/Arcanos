CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_chunks (
    id SERIAL PRIMARY KEY,
    chunk_id UUID DEFAULT gen_random_uuid() UNIQUE,
    source_type TEXT,
    source_tag TEXT,
    metadata JSONB,
    embedding VECTOR(1536),
    content TEXT NOT NULL,
    token_count INT,
    created_at TIMESTAMP DEFAULT NOW()
);

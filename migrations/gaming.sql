-- Main Guides Table
CREATE TABLE IF NOT EXISTS gaming_guides (
    id SERIAL PRIMARY KEY,
    game_name TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT CHECK (type IN ('tutorial','strategy','walkthrough','build','meta')),
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    patch_version TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Builds Table
CREATE TABLE IF NOT EXISTS gaming_builds (
    id SERIAL PRIMARY KEY,
    game_name TEXT NOT NULL,
    role_class TEXT NOT NULL,
    build_description TEXT NOT NULL,
    effectiveness_rating INT CHECK (effectiveness_rating BETWEEN 1 AND 100),
    patch_version TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Meta Tracking Table
CREATE TABLE IF NOT EXISTS gaming_meta (
    id SERIAL PRIMARY KEY,
    game_name TEXT NOT NULL,
    tier_list JSONB,
    patch_notes TEXT,
    balance_changes TEXT,
    patch_version TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

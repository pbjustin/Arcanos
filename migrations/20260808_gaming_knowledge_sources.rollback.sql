-- Roll back only the additive durable Gaming knowledge model.
-- Legacy gaming_guides, gaming_builds, and gaming_meta are intentionally untouched.

DROP TABLE IF EXISTS gaming_knowledge_records;
DROP TABLE IF EXISTS gaming_source_revisions;
DROP TABLE IF EXISTS gaming_sources;

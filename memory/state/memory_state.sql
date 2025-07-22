-- Initial memory boot schema
-- You can later sync this into Postgres or SQLite

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  objective TEXT,
  completed BOOLEAN DEFAULT FALSE
);

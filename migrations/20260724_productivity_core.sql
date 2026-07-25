-- Canonical persistence for the protected ARCANOS productivity capability.
-- This migration is additive and safe to apply more than once.

CREATE TABLE IF NOT EXISTS productivity_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_productivity_projects_scope_id
    UNIQUE (owner_principal_id, workspace_id, id),
  CONSTRAINT ck_productivity_projects_owner
    CHECK (char_length(btrim(owner_principal_id)) > 0),
  CONSTRAINT ck_productivity_projects_workspace
    CHECK (char_length(btrim(workspace_id)) > 0),
  CONSTRAINT ck_productivity_projects_title
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT ck_productivity_projects_description
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 20000),
  CONSTRAINT ck_productivity_projects_status
    CHECK (status IN ('active', 'blocked', 'on_hold', 'completed', 'archived')),
  CONSTRAINT ck_productivity_projects_version
    CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS productivity_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id UUID,
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  priority SMALLINT NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ,
  defer_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_productivity_tasks_owner
    CHECK (char_length(btrim(owner_principal_id)) > 0),
  CONSTRAINT ck_productivity_tasks_workspace
    CHECK (char_length(btrim(workspace_id)) > 0),
  CONSTRAINT ck_productivity_tasks_title
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT ck_productivity_tasks_details
    CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 20000),
  CONSTRAINT ck_productivity_tasks_status
    CHECK (status IN ('inbox', 'next', 'scheduled', 'waiting', 'done', 'cancelled')),
  CONSTRAINT ck_productivity_tasks_priority
    CHECK (priority BETWEEN 0 AND 4),
  CONSTRAINT ck_productivity_tasks_version
    CHECK (version >= 1),
  CONSTRAINT fk_productivity_tasks_project_scope
    FOREIGN KEY (owner_principal_id, workspace_id, project_id)
    REFERENCES productivity_projects(owner_principal_id, workspace_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS productivity_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id UUID,
  title TEXT,
  content TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_productivity_notes_owner
    CHECK (char_length(btrim(owner_principal_id)) > 0),
  CONSTRAINT ck_productivity_notes_workspace
    CHECK (char_length(btrim(workspace_id)) > 0),
  CONSTRAINT ck_productivity_notes_title
    CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT ck_productivity_notes_content
    CHECK (char_length(btrim(content)) BETWEEN 1 AND 100000),
  CONSTRAINT ck_productivity_notes_version
    CHECK (version >= 1),
  CONSTRAINT fk_productivity_notes_project_scope
    FOREIGN KEY (owner_principal_id, workspace_id, project_id)
    REFERENCES productivity_projects(owner_principal_id, workspace_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS productivity_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  review_date DATE NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_productivity_reviews_owner
    CHECK (char_length(btrim(owner_principal_id)) > 0),
  CONSTRAINT ck_productivity_reviews_workspace
    CHECK (char_length(btrim(workspace_id)) > 0),
  CONSTRAINT ck_productivity_reviews_kind
    CHECK (kind IN ('daily', 'weekly')),
  CONSTRAINT ck_productivity_reviews_content
    CHECK (jsonb_typeof(content) = 'object')
);

CREATE TABLE IF NOT EXISTS productivity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_sequence BIGSERIAL NOT NULL,
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  aggregate_version BIGINT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_principal_id TEXT NOT NULL,
  request_id TEXT,
  trace_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  CONSTRAINT uq_productivity_events_sequence
    UNIQUE (event_sequence),
  CONSTRAINT ck_productivity_events_owner
    CHECK (char_length(btrim(owner_principal_id)) > 0),
  CONSTRAINT ck_productivity_events_workspace
    CHECK (char_length(btrim(workspace_id)) > 0),
  CONSTRAINT ck_productivity_events_aggregate_type
    CHECK (aggregate_type IN ('task', 'project', 'note', 'review')),
  CONSTRAINT ck_productivity_events_aggregate_version
    CHECK (aggregate_version IS NULL OR aggregate_version >= 1),
  CONSTRAINT ck_productivity_events_event_type
    CHECK (char_length(btrim(event_type)) > 0),
  CONSTRAINT ck_productivity_events_actor
    CHECK (char_length(btrim(actor_principal_id)) > 0),
  CONSTRAINT ck_productivity_events_payload
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS productivity_command_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  CONSTRAINT uq_productivity_command_receipts_scope_key
    UNIQUE (owner_principal_id, workspace_id, action, idempotency_key_hash),
  CONSTRAINT ck_productivity_command_receipts_owner
    CHECK (char_length(btrim(owner_principal_id)) > 0),
  CONSTRAINT ck_productivity_command_receipts_workspace
    CHECK (char_length(btrim(workspace_id)) > 0),
  CONSTRAINT ck_productivity_command_receipts_action
    CHECK (char_length(btrim(action)) > 0),
  CONSTRAINT ck_productivity_command_receipts_key_hash
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_productivity_command_receipts_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_productivity_command_receipts_result
    CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT ck_productivity_command_receipts_expiry
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_productivity_projects_scope_status_updated
  ON productivity_projects(owner_principal_id, workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_productivity_tasks_scope_status_due
  ON productivity_tasks(owner_principal_id, workspace_id, status, due_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_productivity_tasks_scope_project_status
  ON productivity_tasks(owner_principal_id, workspace_id, project_id, status)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_productivity_notes_scope_updated
  ON productivity_notes(owner_principal_id, workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_productivity_reviews_scope_type_date
  ON productivity_reviews(owner_principal_id, workspace_id, kind, review_date DESC);

CREATE INDEX IF NOT EXISTS idx_productivity_events_scope_occurred
  ON productivity_events(owner_principal_id, workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_productivity_events_unpublished
  ON productivity_events(event_sequence)
  WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_productivity_command_receipts_scope_expires
  ON productivity_command_receipts(owner_principal_id, workspace_id, expires_at);

-- GPT-OSS governance schema for reviewed Arcanos training/eval data.
-- This migration is intentionally not applied by local GPT-OSS scripts.
-- Apply it manually after review in the target Postgres environment.

CREATE TABLE IF NOT EXISTS arcanos_action_registry (
  id BIGSERIAL PRIMARY KEY,
  action_name TEXT NOT NULL UNIQUE,
  plane TEXT NOT NULL CHECK (plane IN ('control-plane', 'writing-plane', 'safety-plane')),
  risk TEXT NOT NULL CHECK (risk IN ('readonly', 'privileged', 'data_governance', 'secret_exposure', 'blocked')),
  requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_by_default BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS arcanos_route_policy (
  id BIGSERIAL PRIMARY KEY,
  route_label TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('readonly', 'privileged', 'data_governance', 'secret_exposure', 'blocked')),
  allowed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_arcanos_route_policy_label_trigger UNIQUE (route_label, trigger_type)
);

CREATE TABLE IF NOT EXISTS arcanos_safety_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_key TEXT NOT NULL UNIQUE,
  rule_text TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  applies_to TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gptoss_eval_runs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  adapter_name TEXT NOT NULL,
  adapter_path TEXT NOT NULL,
  dataset_path TEXT NOT NULL,
  eval_file TEXT NOT NULL,
  force_final_channel BOOLEAN NOT NULL DEFAULT FALSE,
  passed_count INTEGER NOT NULL DEFAULT 0 CHECK (passed_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  openai_called BOOLEAN NOT NULL DEFAULT FALSE,
  training_executed BOOLEAN NOT NULL DEFAULT FALSE,
  vllm_used BOOLEAN NOT NULL DEFAULT FALSE,
  no_openai_output_used BOOLEAN NOT NULL DEFAULT TRUE,
  report_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gptoss_eval_failures (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES gptoss_eval_runs(run_id) ON DELETE CASCADE,
  eval_id TEXT NOT NULL,
  prompt_summary TEXT NOT NULL DEFAULT '',
  expected_shape TEXT NOT NULL DEFAULT '',
  expected_action TEXT,
  expected_label TEXT,
  observed_summary TEXT NOT NULL DEFAULT '',
  failure_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_repair_target TEXT,
  redacted BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gptoss_training_candidates (
  id BIGSERIAL PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_for_training BOOLEAN NOT NULL DEFAULT FALSE,
  requires_human_review BOOLEAN NOT NULL DEFAULT TRUE,
  contains_secret BOOLEAN NOT NULL DEFAULT FALSE,
  no_openai_output_used BOOLEAN NOT NULL DEFAULT TRUE,
  raw_input_summary TEXT NOT NULL DEFAULT '',
  proposed_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_gptoss_candidates_default_not_trainable
    CHECK (allowed_for_training IS FALSE),
  CONSTRAINT chk_gptoss_candidates_review_required
    CHECK (requires_human_review IS TRUE)
);

CREATE TABLE IF NOT EXISTS gptoss_approved_training_examples (
  id BIGSERIAL PRIMARY KEY,
  example_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN (
    'arcanos_owned_spec',
    'repo_schema',
    'human_authored',
    'redacted_consented_log'
  )),
  reviewed BOOLEAN NOT NULL CHECK (reviewed IS TRUE),
  redacted BOOLEAN NOT NULL CHECK (redacted IS TRUE),
  allowed_for_training BOOLEAN NOT NULL CHECK (allowed_for_training IS TRUE),
  no_openai_output_used BOOLEAN NOT NULL CHECK (no_openai_output_used IS TRUE),
  target_shape TEXT NOT NULL CHECK (target_shape IN ('label_only', 'json_only', 'compact_final')),
  task_type TEXT NOT NULL,
  messages JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arcanos_action_registry_source
  ON arcanos_action_registry(source);

CREATE INDEX IF NOT EXISTS idx_arcanos_route_policy_route_label
  ON arcanos_route_policy(route_label);

CREATE INDEX IF NOT EXISTS idx_arcanos_safety_rules_applies_to
  ON arcanos_safety_rules(applies_to);

CREATE INDEX IF NOT EXISTS idx_gptoss_eval_runs_run_id
  ON gptoss_eval_runs(run_id);

CREATE INDEX IF NOT EXISTS idx_gptoss_eval_runs_adapter_created
  ON gptoss_eval_runs(adapter_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gptoss_eval_failures_run_id
  ON gptoss_eval_failures(run_id);

CREATE INDEX IF NOT EXISTS idx_gptoss_eval_failures_eval_id
  ON gptoss_eval_failures(eval_id);

CREATE INDEX IF NOT EXISTS idx_gptoss_training_candidates_candidate_id
  ON gptoss_training_candidates(candidate_id);

CREATE INDEX IF NOT EXISTS idx_gptoss_training_candidates_source
  ON gptoss_training_candidates(source);

CREATE INDEX IF NOT EXISTS idx_gptoss_training_candidates_reviewed_allowed
  ON gptoss_training_candidates(reviewed, allowed_for_training);

CREATE INDEX IF NOT EXISTS idx_gptoss_approved_training_examples_example_id
  ON gptoss_approved_training_examples(example_id);

CREATE INDEX IF NOT EXISTS idx_gptoss_approved_training_examples_source
  ON gptoss_approved_training_examples(source);

CREATE INDEX IF NOT EXISTS idx_gptoss_approved_training_examples_reviewed_allowed
  ON gptoss_approved_training_examples(reviewed, allowed_for_training);

INSERT INTO arcanos_action_registry
  (action_name, plane, risk, requires_confirmation, blocked_by_default, source, description)
VALUES
  ('railway.status', 'control-plane', 'readonly', FALSE, FALSE, 'arcanos_owned_spec', 'Read Railway project status through the safe CLI bridge.'),
  ('railway.logs', 'control-plane', 'readonly', FALSE, FALSE, 'arcanos_owned_spec', 'Read redacted Railway service logs through the safe CLI bridge.'),
  ('railway.variables.list', 'control-plane', 'readonly', FALSE, FALSE, 'arcanos_owned_spec', 'List variable names without exposing values.'),
  ('validate_dataset', 'control-plane', 'data_governance', FALSE, FALSE, 'repo_schema', 'Validate local GPT-OSS dataset rows through the dataset gate.'),
  ('reject_training_from_raw_logs', 'control-plane', 'data_governance', FALSE, TRUE, 'arcanos_owned_spec', 'Reject attempts to use raw logs as training data.'),
  ('reject', 'safety-plane', 'blocked', FALSE, TRUE, 'arcanos_owned_spec', 'Reject unsafe or unknown requests.'),
  ('workers.status', 'control-plane', 'readonly', FALSE, FALSE, 'repo_schema', 'Inspect worker status through approved read-only surfaces.'),
  ('queue.inspect', 'control-plane', 'readonly', FALSE, FALSE, 'repo_schema', 'Inspect queue state through approved read-only surfaces.')
ON CONFLICT (action_name) DO UPDATE SET
  plane = EXCLUDED.plane,
  risk = EXCLUDED.risk,
  requires_confirmation = EXCLUDED.requires_confirmation,
  blocked_by_default = EXCLUDED.blocked_by_default,
  source = EXCLUDED.source,
  description = EXCLUDED.description,
  updated_at = NOW();

INSERT INTO arcanos_route_policy
  (route_label, trigger_type, risk, allowed_actions, forbidden_actions, requires_confirmation, source)
VALUES
  ('control-plane', 'backend_diagnostic', 'readonly',
    '["railway.status","railway.logs","railway.variables.list","workers.status","queue.inspect","validate_dataset"]'::jsonb,
    '["railway.up","railway.ssh","railway.shell","railway.delete","railway.down"]'::jsonb,
    FALSE,
    'arcanos_owned_spec'),
  ('writing-plane', 'code_change', 'readonly',
    '["write_code","edit_docs","prepare_patch"]'::jsonb,
    '["railway.up","railway.ssh","railway.shell","raw_db_dump"]'::jsonb,
    FALSE,
    'arcanos_owned_spec')
ON CONFLICT (route_label, trigger_type) DO UPDATE SET
  risk = EXCLUDED.risk,
  allowed_actions = EXCLUDED.allowed_actions,
  forbidden_actions = EXCLUDED.forbidden_actions,
  requires_confirmation = EXCLUDED.requires_confirmation,
  source = EXCLUDED.source,
  updated_at = NOW();

INSERT INTO arcanos_safety_rules
  (rule_key, rule_text, severity, applies_to, source)
VALUES
  ('openai_output_not_training_data', 'OpenAI model output and judgments must not be used as GPT-OSS training labels.', 'blocking', 'training_export', 'arcanos_owned_spec'),
  ('raw_railway_logs_not_training_data', 'Raw Railway logs must not be stored or exported as trainable examples.', 'blocking', 'candidate_import', 'arcanos_owned_spec'),
  ('secrets_never_trainable', 'Secrets, connection strings, bearer tokens, cookies, and raw environment values are never trainable.', 'blocking', 'all', 'arcanos_owned_spec'),
  ('railway_cli_observation_requires_review', 'Railway CLI observations are candidate-only and require manual conversion to an approved source.', 'blocking', 'candidate_review', 'arcanos_owned_spec'),
  ('privileged_actions_require_confirmation', 'Privileged backend actions require confirmation and remain blocked by default in GPT-OSS training examples.', 'blocking', 'route_policy', 'arcanos_owned_spec')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_text = EXCLUDED.rule_text,
  severity = EXCLUDED.severity,
  applies_to = EXCLUDED.applies_to,
  source = EXCLUDED.source,
  updated_at = NOW();

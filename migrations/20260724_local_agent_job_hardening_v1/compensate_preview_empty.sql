DO $local_agent_idempotency_compensation$
BEGIN
  IF to_regclass('local_agent_job_idempotency') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM local_agent_job_idempotency LIMIT 1) THEN
    RAISE EXCEPTION 'local-agent hardening compensation requires an empty binding table';
  END IF;

  IF to_regclass('job_data') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM job_data
      WHERE job_type = 'local-agent'
        AND status IN ('pending', 'running')
      LIMIT 1
    )
  THEN
    RAISE EXCEPTION 'local-agent hardening compensation refuses active local-agent jobs';
  END IF;
END
$local_agent_idempotency_compensation$;

DROP TABLE IF EXISTS local_agent_job_idempotency;

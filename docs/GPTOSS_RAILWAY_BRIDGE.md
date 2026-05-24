# GPT-OSS Railway CLI Bridge

The Railway CLI bridge is a local-only observation and eval-data drafting tool.
It is not direct model shell access, not automatic training, and not a live
Railway operations router.

Bridge flow:

```text
Railway CLI bridge
  -> allowlisted read-only command
  -> redaction
  -> normalized event/observation
  -> human/spec approval
  -> dataset gate
  -> Unsloth training later
```

Raw Railway output cannot enter GPT-OSS training data. CLI stdout, stderr,
command previews, and normalized observations must be redacted before they are
shown or written. Generated candidates use `source: "railway_cli_observation"`,
`reviewed: false`, and `allowed_for_training: false`; the dataset gate rejects
that source by default. A reviewer must create a separate approved
`human_authored`, `arcanos_owned_spec`, or `repo_schema` record before any
derived example can become training data.

Spec-authored Railway-safe routing examples, such as
`examples/gptoss/arcanos-railway-safe-routing.jsonl`, teach protocol decisions
only. They are optional future dataset material and must not be wired into
execute training scripts without a separate explicit approval step.

The bridge allows only these read-only action names:

- `railway.whoami`
- `railway.status`
- `railway.logs`
- `railway.variables.list`
- `railway.environment`
- `railway.service`

Privileged operations are blocked by default even when a confirmation token is
provided:

- `railway.restart`
- `railway.redeploy`
- `railway.up`
- `railway.variable.set`
- `railway.down`
- `railway.ssh`
- `railway.shell`
- `railway.delete`
- `railway.scale`

Unknown actions fail closed. The bridge builds argv arrays and executes with
`execFile` only when `--execute` is explicitly passed. Dry-run mode returns the
resolved redacted command without running Railway.

Tokens must stay in local environment variables and must never be copied into
prompts, examples, reports, or tickets. `RAILWAY_TOKEN`,
`RAILWAY_API_TOKEN`, `OPENAI_API_KEY`, `DATABASE_URL`, bearer tokens, cookies,
and credential-bearing URLs are redacted. Use Railway CLI scoping flags such as
`--service`, `--environment`, and `--json` where supported.

Safe logs dry-run:

```bash
node scripts/gptoss/railway-cli-bridge.mjs --dry-run --action railway.logs --service <service> --environment production
```

Package scripts that need service/environment values expect operator-supplied
arguments:

```bash
npm run gptoss:railway:logs:dry -- --service <service> --environment production
npm run gptoss:railway:status -- --execute
```

Live execution is still local operator tooling. Do not use it to train, do not
call OpenAI from this path, do not use vLLM, and keep written reports under
`local_artifacts/`.

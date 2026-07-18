#!/bin/sh

set -eu

fail_preflight() {
  printf '%s\n' '{"ok":false,"code":"PHASE2E_VALIDATOR_PRE_NODE_ENVIRONMENT_FORBIDDEN"}' >&2
  exit 1
}

for variable_name in \
  NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_DEBUG NODE_DEBUG_NATIVE \
  NODE_REDIRECT_WARNINGS NODE_REPL_HISTORY NODE_V8_COVERAGE NODE_ICU_DATA \
  LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
do
  eval "variable_present=\${${variable_name}+present}"
  if [ "${variable_present:-}" = 'present' ]; then
    fail_preflight
  fi
done

case "${1:-}" in
  --plan|--apply|--verify|--verify-runtime|--drain)
    exec node scripts/phase2e-migration-validator.mjs "$1"
    ;;
  --pg18-integration)
    if [ "${ACTION_PLAN_EXECUTION_PG18_INTEGRATION:-}" != '1' ] \
      || [ "${ACTION_PLAN_EXECUTION_PG18_RAILWAY_VALIDATION:-}" != '1' ]; then
      printf '%s\n' '{"ok":false,"code":"PHASE2E_PG18_INTEGRATION_FLAGS_REQUIRED"}' >&2
      exit 1
    fi
    node scripts/phase2e-migration-validator.mjs --plan >/dev/null
    exec node scripts/phase2e-pg18-runner.mjs
    ;;
  *)
    printf '%s\n' '{"ok":false,"code":"PHASE2E_VALIDATOR_ARGUMENT_INVALID"}' >&2
    exit 1
    ;;
esac

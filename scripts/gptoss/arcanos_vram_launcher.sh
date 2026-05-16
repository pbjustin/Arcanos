#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

profile="${ARCANOS_GPTOSS_PROFILE:-auto}"
execute=0
args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      profile="${2:?missing value for --profile}"
      shift 2
      ;;
    --execute)
      execute=1
      args+=("$1")
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

export ARCANOS_GPTOSS_PROFILE="${profile}"
export ARCANOS_GPTOSS_DRY_RUN="$([[ "${execute}" -eq 1 ]] && echo 0 || echo 1)"
export ARCANOS_GPTOSS_SMOKE=1

cd "${repo_root}"
exec python3 "${script_dir}/train-smoke.py" --profile "${profile}" "${args[@]}"

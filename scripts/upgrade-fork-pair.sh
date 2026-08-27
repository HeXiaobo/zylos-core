#!/usr/bin/env bash
set -euo pipefail

core_sha=''
args=("$@")
for ((index = 0; index < ${#args[@]}; index += 1)); do
  if [[ "${args[$index]}" == '--core-sha' ]]; then
    core_sha="${args[$((index + 1))]:-}"
    break
  fi
done

if [[ ! "$core_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo '{"status":"HOLD","code":"INVALID_TARGET","error":"--core-sha must be a full immutable 40-hex commit"}' >&2
  exit 2
fi

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/zylos-fork-pair-bootstrap.XXXXXX")"
cleanup() {
  rm -rf -- "$scratch_dir"
}
trap cleanup EXIT INT TERM

curl -fsSL --retry 2 --retry-all-errors \
  "https://github.com/HeXiaobo/zylos-core/archive/${core_sha}.tar.gz" \
  | tar xzf - -C "$scratch_dir" --strip-components=1

node "$scratch_dir/scripts/upgrade-fork-pair.js" \
  --staged-core "$scratch_dir" \
  "$@"

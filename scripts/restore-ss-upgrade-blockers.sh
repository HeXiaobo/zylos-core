#!/usr/bin/env bash
set -euo pipefail

core_sha=''
forwarded=()

while (($#)); do
  case "$1" in
    --core-sha)
      core_sha="${2:-}"
      forwarded+=("$1" "$core_sha")
      shift 2
      ;;
    *)
      forwarded+=("$1")
      shift
      ;;
  esac
done

if [[ ! "$core_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo '{"status":"HOLD","code":"INVALID_TARGET","error":"--core-sha must be a full immutable 40-hex commit"}' >&2
  exit 1
fi

scratch_dir="$(mktemp -d)"
trap 'rm -rf -- "$scratch_dir"' EXIT

curl -fsSL --retry 2 --retry-all-errors \
  "https://raw.githubusercontent.com/HeXiaobo/zylos-core/${core_sha}/scripts/restore-ss-upgrade-blockers.js" \
  -o "$scratch_dir/restore-ss-upgrade-blockers.js"

node "$scratch_dir/restore-ss-upgrade-blockers.js" "${forwarded[@]}"

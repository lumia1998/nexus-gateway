#!/usr/bin/env bash
# Build, package, upload, and transactionally install Nexus Gateway over SSH.
# The remote installer is also shipped in the artifact for independent tests.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REMOTE_HOST="${NEXUS_REMOTE_HOST:-${REMOTE_HOST:-}}"
REMOTE_USER="${NEXUS_REMOTE_USER:-${REMOTE_USER:-}}"
REMOTE_DIR="${NEXUS_REMOTE_DIR:-${REMOTE_DIR:-/opt/nexus-gateway}}"
REMOTE_SERVICE="${NEXUS_REMOTE_SERVICE:-nexus-agentd.service}"
REMOTE_HEALTH_URL="${NEXUS_REMOTE_HEALTH_URL:-http://127.0.0.1:8787/health}"
SSH_KEY_PATH="${NEXUS_SSH_KEY:-${SSH_KEY_PATH:-}}"
SSH_PORT="${NEXUS_SSH_PORT:-${SSH_PORT:-22}}"
REMOTE_TMP_PATH="${NEXUS_REMOTE_TMP:-/tmp/nexus-gateway.tar.gz}"
ARTIFACT_PATH="${NEXUS_ARTIFACT_PATH:-$ROOT_DIR/nexus-gateway.tar.gz}"
SKIP_BUILD="${NEXUS_SKIP_BUILD:-0}"
REMOTE_SCRIPT="$ROOT_DIR/scripts/deploy-remote-install.sh"
CURRENT_STAGE='argument validation'

if [[ "$ARTIFACT_PATH" != /* ]]; then
    ARTIFACT_PATH="$ROOT_DIR/$ARTIFACT_PATH"
fi

fail() {
    printf 'deployment failed: %s\n' "$*" >&2
    exit 1
}

on_error() {
    local status=$?
    printf 'deployment failed during %s (exit %s)\n' "$CURRENT_STAGE" "$status" >&2
    exit "$status"
}
trap on_error ERR

quote_remote_arg() {
    printf '%q' "$1"
}

artifact_checksum() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print tolower($1)}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print tolower($1)}'
    else
        fail 'sha256sum or shasum is required to verify the uploaded artifact'
    fi
}

[[ -n "$REMOTE_HOST" ]] || fail 'set NEXUS_REMOTE_HOST'
[[ -n "$REMOTE_USER" ]] || fail 'set NEXUS_REMOTE_USER'
[[ -n "$SSH_KEY_PATH" ]] || fail 'set NEXUS_SSH_KEY to an SSH private-key path'
[[ -r "$SSH_KEY_PATH" ]] || fail "SSH private key is not readable: $SSH_KEY_PATH"
[[ -r "$REMOTE_SCRIPT" ]] || fail "remote installer is missing: $REMOTE_SCRIPT"
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || fail 'NEXUS_SSH_PORT must be numeric'

SSH_COMMON_OPTIONS=(-o BatchMode=yes -o IdentitiesOnly=yes -i "$SSH_KEY_PATH")
SSH_OPTIONS=("${SSH_COMMON_OPTIONS[@]}" -p "$SSH_PORT")
SCP_OPTIONS=("${SSH_COMMON_OPTIONS[@]}" -P "$SSH_PORT")
SSH_TARGET="$REMOTE_USER@$REMOTE_HOST"

if [[ "$SKIP_BUILD" != '1' ]]; then
    CURRENT_STAGE='building project'
    (cd "$ROOT_DIR" && npm run build)
fi

CURRENT_STAGE='creating deployment artifact'
(cd "$ROOT_DIR" && node scripts/package-deploy.mjs --artifact "$ARTIFACT_PATH")
[[ -r "$ARTIFACT_PATH" ]] || fail "deployment artifact was not created: $ARTIFACT_PATH"

CURRENT_STAGE='computing artifact checksum'
ARTIFACT_SHA256="$(artifact_checksum "$ARTIFACT_PATH")"

CURRENT_STAGE='uploading deployment artifact'
scp "${SCP_OPTIONS[@]}" "$ARTIFACT_PATH" "$SSH_TARGET:$REMOTE_TMP_PATH"

CURRENT_STAGE='installing release on remote host'
REMOTE_COMMAND="bash -s -- $(quote_remote_arg "$REMOTE_TMP_PATH") $(quote_remote_arg "$REMOTE_DIR") $(quote_remote_arg "$REMOTE_SERVICE") $(quote_remote_arg "$REMOTE_HEALTH_URL") $(quote_remote_arg "$ARTIFACT_SHA256")"
ssh "${SSH_OPTIONS[@]}" "$SSH_TARGET" "$REMOTE_COMMAND" < "$REMOTE_SCRIPT"

printf 'Deployment complete: %s at %s\n' "$REMOTE_SERVICE" "$REMOTE_HEALTH_URL"

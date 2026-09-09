#!/usr/bin/env bash
# Install one already-uploaded Nexus Gateway artifact on the remote host.
# This file is streamed over SSH by deploy-remote.sh and is also runnable by
# itself for non-interactive local regression tests.

set -Eeuo pipefail

ARTIFACT_PATH="${1:-}"
BASE_DIR="${2:-/opt/nexus-gateway}"
SERVICE_NAME="${3:-nexus-agentd.service}"
HEALTH_URL="${4:-http://127.0.0.1:8787/health}"
EXPECTED_SHA256="${5:-${NEXUS_ARTIFACT_SHA256:-}}"
HEALTH_ATTEMPTS="${NEXUS_HEALTH_ATTEMPTS:-15}"
HEALTH_DELAY_SECONDS="${NEXUS_HEALTH_DELAY_SECONDS:-2}"
SYSTEMCTL_BIN="${NEXUS_SYSTEMCTL_BIN:-systemctl}"
CURRENT_STAGE='argument validation'

fail() {
    printf 'remote deployment failed: %s\n' "$*" >&2
    exit 1
}

on_error() {
    local status=$?
    printf 'remote deployment failed during %s (exit %s)\n' "$CURRENT_STAGE" "$status" >&2
    exit "$status"
}
trap on_error ERR

main() {
[[ -n "$ARTIFACT_PATH" ]] || fail 'usage: deploy-remote-install.sh ARTIFACT BASE_DIR SERVICE_NAME HEALTH_URL'
[[ -r "$ARTIFACT_PATH" ]] || fail "artifact is not readable: $ARTIFACT_PATH"
[[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail 'NEXUS_HEALTH_ATTEMPTS must be a positive integer'
[[ "$HEALTH_DELAY_SECONDS" =~ ^[0-9]+$ ]] || fail 'NEXUS_HEALTH_DELAY_SECONDS must be a non-negative integer'
[[ "$EXPECTED_SHA256" =~ ^[A-Fa-f0-9]{64}$ ]] || fail 'an artifact SHA-256 checksum is required'

CURRENT_STAGE='checking Node.js runtime'
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 20 ]] || fail "Node.js 20 or newer is required (found $NODE_MAJOR)"

CURRENT_STAGE='verifying artifact checksum'
verify_checksum

CURRENT_STAGE='checking archive paths'
verify_archive_paths

CURRENT_STAGE='reading deployment version'
VERSION="$(read_version)"
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "invalid deployment version: $VERSION"

RELEASES_DIR="$BASE_DIR/releases"
CURRENT_LINK="$BASE_DIR/current"
NEW_RELEASE="$RELEASES_DIR/$VERSION"
OLD_RELEASE=''

if [[ -L "$CURRENT_LINK" ]]; then
    OLD_RELEASE="$(readlink -f "$CURRENT_LINK")"
elif [[ -e "$CURRENT_LINK" ]]; then
    fail "current path exists but is not a symlink: $CURRENT_LINK"
fi

if [[ -e "$NEW_RELEASE" || -L "$NEW_RELEASE" ]]; then
    fail "release directory already exists: $NEW_RELEASE"
fi

CURRENT_STAGE='creating release directory'
mkdir -p "$RELEASES_DIR"
mkdir "$NEW_RELEASE"

CURRENT_STAGE='extracting artifact'
tar -xzf "$ARTIFACT_PATH" -C "$NEW_RELEASE"
[[ -f "$NEW_RELEASE/package.json" && -f "$NEW_RELEASE/package-lock.json" ]] ||
    fail 'artifact does not contain package.json and package-lock.json'

CURRENT_STAGE='installing production dependencies'
(cd "$NEW_RELEASE" && npm ci --omit=dev)

CURRENT_STAGE='reloading systemd configuration'
systemctl_command daemon-reload

CURRENT_STAGE='switching current release'
switch_current "$NEW_RELEASE"

CURRENT_STAGE='restarting systemd service'
if ! systemctl_command restart "$SERVICE_NAME"; then
    rollback_after_failure 'systemd restart failed'
fi

CURRENT_STAGE='checking service health'
if ! wait_for_health; then
    rollback_after_failure 'health check failed'
fi

printf 'Deployment complete: version %s is healthy at %s\n' "$VERSION" "$CURRENT_LINK"
exit 0
}

read_version() {
    local value
    value="$(tar -xOf "$ARTIFACT_PATH" ./DEPLOY_VERSION 2>/dev/null || true)"
    if [[ -z "$value" ]]; then
        value="$(tar -xOf "$ARTIFACT_PATH" DEPLOY_VERSION 2>/dev/null || true)"
    fi
    value="${value//$'\r'/}"
    value="${value//$'\n'/}"
    [[ -n "$value" ]] || fail 'artifact is missing DEPLOY_VERSION'
    printf '%s' "$value"
}

systemctl_command() {
    if [[ -n "${NEXUS_SYSTEMCTL_BIN:-}" || "${NEXUS_SYSTEMCTL_NO_SUDO:-0}" == '1' || "$(id -u)" == '0' ]]; then
        "$SYSTEMCTL_BIN" "$@"
    else
        sudo -n "$SYSTEMCTL_BIN" "$@"
    fi
}

switch_current() {
    local target=$1
    local temporary="$BASE_DIR/.current.$$"
    rm -f "$temporary"
    ln -s "$target" "$temporary"
    mv -Tf "$temporary" "$CURRENT_LINK"
}

rollback_after_failure() {
    local reason=$1
    CURRENT_STAGE='rolling back failed release'
    if [[ -n "$OLD_RELEASE" ]]; then
        switch_current "$OLD_RELEASE"
        if ! systemctl_command restart "$SERVICE_NAME"; then
            fail "$reason; rollback restart failed"
        fi
        CURRENT_STAGE='checking rolled-back service health'
        if wait_for_health; then
            printf '%s; rolled back to %s\n' "$reason" "$(basename "$OLD_RELEASE")" >&2
            exit 1
        fi
        fail "$reason; rolled-back release is unhealthy"
    fi

    # There was no previous release to restore. Leave the failed release in
    # place for inspection, remove only the exact current symlink, and stop
    # the service.
    rm -f "$CURRENT_LINK"
    if ! systemctl_command stop "$SERVICE_NAME"; then
        fail "$reason for first release $VERSION; service stop failed"
    fi
    fail "$reason for first release $VERSION; service was stopped"
}

wait_for_health() {
    local attempt body
    for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
        if body="$(curl --fail --silent --show-error --max-time 5 "$HEALTH_URL")" &&
            printf '%s' "$body" | node -e '
                let input = ""
                process.stdin.setEncoding("utf8")
                process.stdin.on("data", (chunk) => { input += chunk })
                process.stdin.on("end", () => {
                    try {
                        const health = JSON.parse(input)
                        process.exit(health.ok === true ? 0 : 1)
                    } catch {
                        process.exit(1)
                    }
                })
            '
        then
            return 0
        fi
        if ((attempt < HEALTH_ATTEMPTS)); then sleep "$HEALTH_DELAY_SECONDS"; fi
    done
    return 1
}

verify_checksum() {
    local actual
    actual="$(sha256sum "$ARTIFACT_PATH" | awk '{print tolower($1)}')"
    [[ "$actual" == "${EXPECTED_SHA256,,}" ]] ||
        fail "artifact checksum mismatch (expected $EXPECTED_SHA256, got $actual)"
}

verify_archive_paths() {
    local entry normalized
    while IFS= read -r entry; do
        normalized="${entry#./}"
        [[ -n "$normalized" ]] || continue
        case "$normalized" in
            /*|../*|*/../*|*/..|[A-Za-z]:/*)
                fail "artifact contains unsafe path: $entry"
                ;;
        esac
        [[ "$normalized" != *$'\r'* && "$normalized" != *$'\n'* ]] ||
            fail 'artifact contains a path with a line break'
    done < <(tar -tzf "$ARTIFACT_PATH")
}

main "$@"

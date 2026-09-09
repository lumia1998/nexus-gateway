#!/usr/bin/env bash
# Non-interactive regression for the remote deployment transaction. It uses a
# local artifact and mock npm/curl/systemctl commands; it never opens SSH.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REMOTE_INSTALLER="$ROOT_DIR/scripts/deploy-remote-install.sh"
TMP_BASE="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
TEMP_ROOT="$(mktemp -d "$TMP_BASE/nexus-deploy-regression.XXXXXX")"
TEMP_ROOT="$(cd -- "$TEMP_ROOT" && pwd -P)"
case "$TEMP_ROOT" in
    "$TMP_BASE"/nexus-deploy-regression.*) ;;
    *) printf 'mktemp returned an unexpected path: %s\n' "$TEMP_ROOT" >&2; exit 1 ;;
esac
cleanup() {
    case "$TEMP_ROOT" in
        "$TMP_BASE"/nexus-deploy-regression.*) rm -rf -- "$TEMP_ROOT" ;;
        *) printf 'refusing to clean unexpected path: %s\n' "$TEMP_ROOT" >&2; return 1 ;;
    esac
}
trap cleanup EXIT

MOCK_BIN="$TEMP_ROOT/bin"
mkdir -p "$MOCK_BIN"

cat >"$MOCK_BIN/npm" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${NEXUS_MOCK_NPM_LOG:?}"
if [[ "${NEXUS_MOCK_NPM_FAIL:-0}" == '1' ]]; then exit 42; fi
EOF

cat >"$MOCK_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${NEXUS_MOCK_SYSTEMCTL_LOG:?}"
if [[ "${NEXUS_MOCK_SYSTEMCTL_FAIL:-0}" == '1' ]]; then exit 43; fi
EOF

cat >"$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
counter_file="${NEXUS_MOCK_CURL_COUNTER:?}"
count=0
if [[ -f "$counter_file" ]]; then count=$(<"$counter_file"); fi
count=$((count + 1))
printf '%s' "$count" >"$counter_file"
if [[ "${NEXUS_MOCK_CURL_FAIL_FIRST:-0}" == '1' && "$count" == '1' ]]; then
    printf '{"ok":false}'
else
    printf '{"ok":true}'
fi
EOF

chmod +x "$MOCK_BIN/npm" "$MOCK_BIN/systemctl" "$MOCK_BIN/curl"

make_artifact() {
    local version=$1
    local stage="$TEMP_ROOT/stage-$version"
    local artifact="$TEMP_ROOT/$version.tar.gz"
    mkdir -p "$stage"
    printf '%s\n' "$version" >"$stage/DEPLOY_VERSION"
    printf '{"name":"nexus-agentd","version":"%s"}\n' "$version" >"$stage/package.json"
    printf '{"name":"nexus-agentd","version":"%s","lockfileVersion":3,"packages":{"":{"name":"nexus-agentd","version":"%s"}}}\n' "$version" "$version" >"$stage/package-lock.json"
    mkdir -p "$stage/dist"
    printf 'fixture\n' >"$stage/dist/cli.js"
    tar -czf "$artifact" -C "$stage" .
    printf '%s' "$artifact"
}

make_old_release() {
    local base=$1
    mkdir -p "$base/releases/old"
    printf 'old\n' >"$base/releases/old/VERSION"
    ln -s "$base/releases/old" "$base/current"
}

checksum() {
    sha256sum "$1" | awk '{print tolower($1)}'
}

export PATH="$MOCK_BIN:$PATH"
export NEXUS_SYSTEMCTL_BIN="$MOCK_BIN/systemctl"
export NEXUS_SYSTEMCTL_NO_SUDO=1
export NEXUS_HEALTH_ATTEMPTS=1
export NEXUS_HEALTH_DELAY_SECONDS=0
export NEXUS_MOCK_NPM_LOG="$TEMP_ROOT/npm.log"
export NEXUS_MOCK_SYSTEMCTL_LOG="$TEMP_ROOT/systemctl.log"
export NEXUS_MOCK_CURL_COUNTER="$TEMP_ROOT/curl.count"

BASE_SUCCESS="$TEMP_ROOT/success"
make_old_release "$BASE_SUCCESS"
SUCCESS_ARTIFACT="$(make_artifact new)"
bash "$REMOTE_INSTALLER" "$SUCCESS_ARTIFACT" "$BASE_SUCCESS" nexus-agentd.service http://127.0.0.1:8787/health "$(checksum "$SUCCESS_ARTIFACT")"
[[ "$(basename "$(readlink -f "$BASE_SUCCESS/current")")" == 'new' ]] || {
    printf 'success case did not switch current release\n' >&2
    exit 1
}

BASE_INSTALL_FAIL="$TEMP_ROOT/install-fail"
make_old_release "$BASE_INSTALL_FAIL"
FAIL_ARTIFACT="$(make_artifact install-fail)"
if NEXUS_MOCK_NPM_FAIL=1 bash "$REMOTE_INSTALLER" "$FAIL_ARTIFACT" "$BASE_INSTALL_FAIL" nexus-agentd.service http://127.0.0.1:8787/health "$(checksum "$FAIL_ARTIFACT")"; then
    printf 'npm failure was reported as success\n' >&2
    exit 1
fi
[[ "$(basename "$(readlink -f "$BASE_INSTALL_FAIL/current")")" == 'old' ]] || {
    printf 'npm failure changed current release\n' >&2
    exit 1
}

BASE_CHECKSUM_FAIL="$TEMP_ROOT/checksum-fail"
make_old_release "$BASE_CHECKSUM_FAIL"
CHECKSUM_ARTIFACT="$(make_artifact checksum-fail)"
if bash "$REMOTE_INSTALLER" "$CHECKSUM_ARTIFACT" "$BASE_CHECKSUM_FAIL" nexus-agentd.service http://127.0.0.1:8787/health "0000000000000000000000000000000000000000000000000000000000000000"; then
    printf 'checksum failure was reported as success\n' >&2
    exit 1
fi
[[ "$(basename "$(readlink -f "$BASE_CHECKSUM_FAIL/current")")" == 'old' ]] || {
    printf 'checksum failure changed current release\n' >&2
    exit 1
}

BASE_HEALTH_FAIL="$TEMP_ROOT/health-fail"
make_old_release "$BASE_HEALTH_FAIL"
HEALTH_ARTIFACT="$(make_artifact health-fail)"
rm -f "$NEXUS_MOCK_CURL_COUNTER"
if NEXUS_MOCK_CURL_FAIL_FIRST=1 bash "$REMOTE_INSTALLER" "$HEALTH_ARTIFACT" "$BASE_HEALTH_FAIL" nexus-agentd.service http://127.0.0.1:8787/health "$(checksum "$HEALTH_ARTIFACT")"; then
    printf 'health failure was reported as success\n' >&2
    exit 1
fi
[[ "$(basename "$(readlink -f "$BASE_HEALTH_FAIL/current")")" == 'old' ]] || {
    printf 'health failure did not roll back current release\n' >&2
    exit 1
}

printf 'Deployment regression passed: install failure and health rollback return non-zero.\n'

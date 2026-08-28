#!/usr/bin/env bash
set -euo pipefail

FORK_DIR="/root/openclaw-fork"
REPO="rocodeveloper/openclaw"
BRANCH="rocobot-v2026.7"
WORKFLOW="Build Fork"
ARTIFACT_NAME="openclaw-fork"
ARTIFACT_DIR="/tmp/openclaw-build"
INSTALL_DIR="/usr/lib/node_modules/openclaw"
BIN_LINK="/usr/bin/openclaw"
RUN_WAIT_ATTEMPTS=24
RUN_WAIT_SECONDS=5

cd "$FORK_DIR"

deploy_only=false
selected_run_id=""
selected_commit=""
while (($# > 0)); do
  case "$1" in
    --deploy-only)
      deploy_only=true
      shift
      ;;
    --run-id|--run)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "ERROR: $1 requires a run ID." >&2
        exit 2
      fi
      selected_run_id="$2"
      shift 2
      ;;
    --commit)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "ERROR: --commit requires a full commit SHA." >&2
        exit 2
      fi
      selected_commit="$2"
      shift 2
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -n "$selected_run_id" && ! "$selected_run_id" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Run ID must contain only digits." >&2
  exit 2
fi
if [[ -n "$selected_commit" && ! "$selected_commit" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: Commit selection must be a full 40-character SHA." >&2
  exit 2
fi
if [[ "$deploy_only" == true && -z "$selected_run_id" && -z "$selected_commit" ]]; then
  echo "ERROR: --deploy-only requires --run-id RUN_ID or --commit SHA." >&2
  exit 2
fi
if [[ "$deploy_only" == false && ( -n "$selected_run_id" || -n "$selected_commit" ) ]]; then
  echo "ERROR: --run-id and --commit require --deploy-only." >&2
  exit 2
fi
if [[ -n "$selected_run_id" && -n "$selected_commit" ]]; then
  echo "ERROR: Select a run ID or a commit, not both." >&2
  exit 2
fi

find_run_for_commit() {
  local commit_sha="$1"
  gh run list \
    --repo "$REPO" \
    --workflow "$WORKFLOW" \
    --commit "$commit_sha" \
    --limit 1 \
    --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$commit_sha\") | .databaseId"
}

wait_for_commit_run() {
  local commit_sha="$1"
  local attempt
  local run_id
  for ((attempt = 1; attempt <= RUN_WAIT_ATTEMPTS; attempt++)); do
    run_id="$(find_run_for_commit "$commit_sha")"
    if [[ -n "$run_id" ]]; then
      printf '%s\n' "$run_id"
      return 0
    fi
    if (( attempt < RUN_WAIT_ATTEMPTS )); then
      sleep "$RUN_WAIT_SECONDS"
    fi
  done
  return 1
}

verify_run() {
  local run_id="$1"
  local expected_commit="$2"
  local record
  local head_sha
  local status
  local conclusion
  local workflow_name

  record="$(gh run view "$run_id" --repo "$REPO" --json headSha,status,conclusion,workflowName --jq '[.headSha, .status, .conclusion, .workflowName] | @tsv')"
  IFS=$'\t' read -r head_sha status conclusion workflow_name <<< "$record"
  if [[ "$workflow_name" != "$WORKFLOW" ]]; then
    echo "ERROR: Run $run_id is not the $WORKFLOW workflow." >&2
    return 1
  fi
  if [[ -n "$expected_commit" && "$head_sha" != "$expected_commit" ]]; then
    echo "ERROR: Run $run_id targets $head_sha, not $expected_commit." >&2
    return 1
  fi
  if [[ "$status" != completed || "$conclusion" != success ]]; then
    echo "ERROR: Run $run_id did not complete successfully ($status/$conclusion)." >&2
    return 1
  fi
  printf '%s\n' "$head_sha"
}

get_run_commit() {
  local run_id="$1"
  local record
  local head_sha
  local workflow_name

  record="$(gh run view "$run_id" --repo "$REPO" --json headSha,workflowName --jq '[.headSha, .workflowName] | @tsv')"
  IFS=$'\t' read -r head_sha workflow_name <<< "$record"
  if [[ "$workflow_name" != "$WORKFLOW" ]]; then
    echo "ERROR: Run $run_id is not the $WORKFLOW workflow." >&2
    return 1
  fi
  printf '%s\n' "$head_sha"
}

if [[ "$deploy_only" == false ]]; then
  echo "=== Pushing $BRANCH to trigger build ==="
  git push origin "$BRANCH"
  COMMIT_SHA="$(git rev-parse "$BRANCH^{commit}")"
  echo "Pushed commit: $COMMIT_SHA"

  echo "=== Waiting for build workflow for $COMMIT_SHA ==="
  if ! RUN_ID="$(wait_for_commit_run "$COMMIT_SHA")"; then
    echo "ERROR: No $WORKFLOW run found for $COMMIT_SHA." >&2
    exit 1
  fi
else
  if [[ -n "$selected_run_id" ]]; then
    RUN_ID="$selected_run_id"
    echo "=== Using selected build run $RUN_ID ==="
    COMMIT_SHA="$(get_run_commit "$RUN_ID")"
  else
    COMMIT_SHA="$selected_commit"
    echo "=== Finding build workflow for $COMMIT_SHA ==="
    if ! RUN_ID="$(wait_for_commit_run "$COMMIT_SHA")"; then
      echo "ERROR: No $WORKFLOW run found for $COMMIT_SHA." >&2
      exit 1
    fi
  fi
fi

echo "Build run: https://github.com/$REPO/actions/runs/$RUN_ID"
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  echo "ERROR: Build failed. Check logs at https://github.com/$REPO/actions/runs/$RUN_ID" >&2
  exit 1
fi
COMMIT_SHA="$(verify_run "$RUN_ID" "$COMMIT_SHA")"

echo "=== Downloading artifact for $COMMIT_SHA from run $RUN_ID ==="
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"
gh run download "$RUN_ID" --repo "$REPO" --name "$ARTIFACT_NAME" --dir "$ARTIFACT_DIR"

mapfile -t tarballs < <(find "$ARTIFACT_DIR" -type f -name 'openclaw-*.tgz' -print | sort)
if (( ${#tarballs[@]} != 1 )); then
  echo "ERROR: Expected one tarball in the artifact, found ${#tarballs[@]}." >&2
  exit 1
fi
TARBALL="${tarballs[0]}"
tar -tzf "$TARBALL" >/dev/null
echo "Artifact: $TARBALL"

STAGING_DIR="${INSTALL_DIR}.staging.$$"
PREVIOUS_DIR="${INSTALL_DIR}.previous.$$"
FAILED_DIR="${INSTALL_DIR}.failed.$$"
path_exists() {
  [[ -e "$1" || -L "$1" ]]
}
for path in "$STAGING_DIR" "$PREVIOUS_DIR" "$FAILED_DIR"; do
  if path_exists "$path"; then
    echo "ERROR: Temporary deployment path already exists: $path" >&2
    exit 1
  fi
done

mkdir "$STAGING_DIR"
echo "=== Extracting $TARBALL ==="
tar xzf "$TARBALL" -C "$STAGING_DIR" --strip-components=1

# Use a local install because global npm resolution exceeds the VPS memory limit.
echo "=== Installing dependencies ==="
cd "$STAGING_DIR"
npm install --omit=dev --ignore-scripts
node scripts/postinstall-bundled-plugins.mjs

rollback_needed=false
rollback_transaction() {
  if [[ "$rollback_needed" != true ]]; then
    return 0
  fi
  rollback_needed=false
  set +e
  echo "=== Restoring previous install ===" >&2
  systemctl --user stop openclaw-gateway >/dev/null 2>&1
  if path_exists "$INSTALL_DIR"; then
    mv "$INSTALL_DIR" "$FAILED_DIR"
  fi
  if ! path_exists "$PREVIOUS_DIR"; then
    echo "ERROR: Previous install is unavailable at $PREVIOUS_DIR." >&2
    set -e
    return 1
  fi
  mv "$PREVIOUS_DIR" "$INSTALL_DIR"
  ln -sf ../lib/node_modules/openclaw/openclaw.mjs "$BIN_LINK"
  if ! systemctl --user start openclaw-gateway; then
    echo "ERROR: Previous gateway failed to start." >&2
    set -e
    return 1
  fi
  sleep 3
  if ! systemctl --user is-active --quiet openclaw-gateway; then
    echo "ERROR: Previous gateway is not active after rollback." >&2
    set -e
    return 1
  fi
  rm -rf "$FAILED_DIR"
  echo "Previous install restored and gateway started." >&2
  set -e
}
trap rollback_transaction EXIT

echo "=== Stopping gateway ==="
if ! systemctl --user stop openclaw-gateway; then
  echo "ERROR: Gateway did not stop. The current install was not changed." >&2
  exit 1
fi

echo "=== Switching installs ==="
if path_exists "$INSTALL_DIR"; then
  mv "$INSTALL_DIR" "$PREVIOUS_DIR"
fi
rollback_needed=true
mv "$STAGING_DIR" "$INSTALL_DIR"
ln -sf ../lib/node_modules/openclaw/openclaw.mjs "$BIN_LINK"

echo "=== Starting gateway ==="
if ! systemctl --user start openclaw-gateway; then
  echo "ERROR: New gateway failed to start." >&2
  exit 1
fi
sleep 3
if ! systemctl --user is-active --quiet openclaw-gateway; then
  echo "ERROR: New gateway is not active after startup." >&2
  exit 1
fi

rollback_needed=false
trap - EXIT
rm -rf "$PREVIOUS_DIR" "$ARTIFACT_DIR"
echo ""
echo "=== Deployed $(openclaw --version) from $COMMIT_SHA ==="

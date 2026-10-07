#!/usr/bin/env bash
set -euo pipefail

REPO="rocodeveloper/openclaw"
BRANCH="rocobot"
WORKFLOW="Build Fork"
ARTIFACT_DIR="/tmp/openclaw-build"
INSTALL_DIR="/usr/lib/node_modules/openclaw"
BIN_LINK="/usr/bin/openclaw"
RUN_WAIT_ATTEMPTS=24
RUN_WAIT_SECONDS=5

cd "$(dirname "${BASH_SOURCE[0]}")"

deploy_only=false
selected_tag=""
selected_commit=""
while (($# > 0)); do
  case "$1" in
    --deploy-only)
      deploy_only=true
      shift
      ;;
    --tag)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "ERROR: --tag requires a release tag." >&2
        exit 2
      fi
      selected_tag="$2"
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

if [[ -n "$selected_tag" && ! "$selected_tag" =~ ^rocobot-[0-9A-Za-z.+-]+-[0-9a-f]{12}$ ]]; then
  echo "ERROR: Release tag must look like rocobot-<version>-<12-character sha>." >&2
  exit 2
fi
if [[ -n "$selected_commit" && ! "$selected_commit" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: Commit selection must be a full 40-character SHA." >&2
  exit 2
fi
if [[ "$deploy_only" == true && -z "$selected_tag" && -z "$selected_commit" ]]; then
  echo "ERROR: --deploy-only requires --tag TAG or --commit SHA." >&2
  exit 2
fi
if [[ "$deploy_only" == false && ( -n "$selected_tag" || -n "$selected_commit" ) ]]; then
  echo "ERROR: --tag and --commit require --deploy-only." >&2
  exit 2
fi
if [[ -n "$selected_tag" && -n "$selected_commit" ]]; then
  echo "ERROR: Select a release tag or a commit, not both." >&2
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

find_release_for_commit() {
  local commit_sha="$1"
  local short_sha="${commit_sha:0:12}"
  gh release list \
    --repo "$REPO" \
    --limit 100 \
    --json tagName \
    --jq ".[] | select(.tagName | startswith(\"rocobot-\") and endswith(\"-$short_sha\")) | .tagName"
}

get_release_commit() {
  local tag="$1"
  local target
  target="$(gh release view "$tag" --repo "$REPO" --json targetCommitish --jq .targetCommitish)"
  if [[ ! "$target" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: Release $tag does not target a full commit SHA." >&2
    return 1
  fi
  printf '%s\n' "$target"
}

if [[ -n "$selected_tag" ]]; then
  RELEASE_TAG="$selected_tag"
  echo "=== Using selected release $RELEASE_TAG ==="
  COMMIT_SHA="$(get_release_commit "$RELEASE_TAG")"
else
  if [[ "$deploy_only" == false ]]; then
    echo "=== Pushing $BRANCH to trigger build ==="
    git push origin "$BRANCH"
    COMMIT_SHA="$(git rev-parse "$BRANCH^{commit}")"
    echo "Pushed commit: $COMMIT_SHA"
  else
    COMMIT_SHA="$selected_commit"
  fi

  echo "=== Waiting for build workflow for $COMMIT_SHA ==="
  if ! RUN_ID="$(wait_for_commit_run "$COMMIT_SHA")"; then
    echo "ERROR: No $WORKFLOW run found for $COMMIT_SHA." >&2
    exit 1
  fi
  echo "Build run: https://github.com/$REPO/actions/runs/$RUN_ID"
  if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
    echo "ERROR: Build failed. Check logs at https://github.com/$REPO/actions/runs/$RUN_ID" >&2
    exit 1
  fi
  verify_run "$RUN_ID" "$COMMIT_SHA" >/dev/null
  RELEASE_TAG="$(find_release_for_commit "$COMMIT_SHA")"
  if [[ -z "$RELEASE_TAG" || "$RELEASE_TAG" == *$'\n'* ]]; then
    echo "ERROR: Expected one release for $COMMIT_SHA." >&2
    exit 1
  fi
  if [[ "$(get_release_commit "$RELEASE_TAG")" != "$COMMIT_SHA" ]]; then
    echo "ERROR: Release $RELEASE_TAG does not target $COMMIT_SHA." >&2
    exit 1
  fi
fi

echo "=== Downloading release $RELEASE_TAG for $COMMIT_SHA ==="
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"
gh release download "$RELEASE_TAG" --repo "$REPO" --pattern 'openclaw-*.tgz' --dir "$ARTIFACT_DIR"

mapfile -t tarballs < <(find "$ARTIFACT_DIR" -type f -name 'openclaw-*.tgz' -print | sort)
if (( ${#tarballs[@]} != 1 )); then
  echo "ERROR: Expected one tarball in the release, found ${#tarballs[@]}." >&2
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

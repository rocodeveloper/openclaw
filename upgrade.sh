#!/usr/bin/env bash
set -euo pipefail

FORK_DIR="/root/openclaw-fork"
REPO="rocodeveloper/openclaw"
BRANCH="rocobot-v2026.7"
ARTIFACT_DIR="/tmp/openclaw-build"
INSTALL_DIR="/usr/lib/node_modules/openclaw"
BIN_LINK="/usr/bin/openclaw"

cd "$FORK_DIR"

deploy_only=false
for arg in "$@"; do
  case "$arg" in
    --deploy-only) deploy_only=true ;;
  esac
done

if [[ "$deploy_only" == false ]]; then
  echo "=== Pushing $BRANCH to trigger build ==="
  git push origin "$BRANCH"

  echo "=== Waiting for build workflow ==="
  sleep 5
  RUN_ID=$(gh run list --repo "$REPO" --branch "$BRANCH" --workflow "Build Fork" --limit 1 --json databaseId --jq '.[0].databaseId')
  if [[ -z "$RUN_ID" ]]; then
    echo "ERROR: No build run found. Check GitHub Actions."
    exit 1
  fi
  echo "Build run: https://github.com/$REPO/actions/runs/$RUN_ID"
  if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
    echo "ERROR: Build failed. Check logs at https://github.com/$REPO/actions/runs/$RUN_ID"
    exit 1
  fi
fi

echo "=== Downloading latest successful build artifact ==="
rm -rf "$ARTIFACT_DIR"
RUN_ID=$(gh run list --repo "$REPO" --branch "$BRANCH" --workflow "Build Fork" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
if [[ -z "$RUN_ID" ]]; then
  echo "ERROR: No successful build found."
  exit 1
fi
gh run download "$RUN_ID" --repo "$REPO" --name openclaw-fork --dir "$ARTIFACT_DIR"
TARBALL=$(ls "$ARTIFACT_DIR"/openclaw-*.tgz 2>/dev/null | head -1)
if [[ -z "$TARBALL" ]]; then
  echo "ERROR: No tarball found in artifact."
  exit 1
fi
echo "Artifact: $TARBALL"

# Use a local install because global npm resolution exceeds the VPS memory limit.
echo "=== Stopping gateway ==="
systemctl --user stop openclaw-gateway

echo "=== Extracting $TARBALL ==="
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1

echo "=== Installing dependencies ==="
cd "$INSTALL_DIR"
npm install --omit=dev --ignore-scripts
# Run this postinstall because --ignore-scripts skips the Baileys hotfix.
node scripts/postinstall-bundled-plugins.mjs

echo "=== Linking binary ==="
ln -sf ../lib/node_modules/openclaw/openclaw.mjs "$BIN_LINK"

echo "=== Starting gateway ==="
systemctl --user start openclaw-gateway

sleep 3
systemctl --user status openclaw-gateway --no-pager | head -5
echo ""
echo "=== Deployed $(openclaw --version) ==="

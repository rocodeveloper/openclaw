#!/usr/bin/env bash
# Build the fork via GitHub Actions and (re)deploy the tarball to this VPS.
#
# Usage:
#   bash /root/openclaw-fork/upgrade.sh               # push branch -> build -> deploy
#   bash /root/openclaw-fork/upgrade.sh --deploy-only # download latest successful artifact + deploy
#
# NOTE: syncing with upstream + re-applying the fork's changes is a MANUAL
# process now (re-apply worklist in tasks/open/[1]-029-fork-rebuild-v2026.6).
# This script no longer auto-rebases — it only builds the current branch and
# deploys the resulting tarball.
set -euo pipefail

FORK_DIR="/root/openclaw-fork"
REPO="rocodeveloper/openclaw"
BRANCH="rocobot-v2026.6"
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

# ── Build via GH Actions ────────────────────────────────────────
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

# ── Download artifact ───────────────────────────────────────────
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

# ── Deploy ──────────────────────────────────────────────────────
# Use tar + local npm install instead of `npm install -g` to avoid OOM on the
# low-memory VPS (global install loads the whole dependency tree for resolution).
echo "=== Stopping gateway ==="
systemctl --user stop openclaw-gateway

echo "=== Extracting $TARBALL ==="
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1

echo "=== Installing dependencies ==="
cd "$INSTALL_DIR"
# NOTE (Option A / bundled whatsapp): baileys ships a postinstall hotfix via
# scripts/postinstall-bundled-plugins.mjs. --ignore-scripts skips it; if whatsapp
# misbehaves after deploy, re-run that script or drop --ignore-scripts here.
npm install --omit=dev --ignore-scripts 2>&1 | tail -3

echo "=== Linking binary ==="
ln -sf ../lib/node_modules/openclaw/openclaw.mjs "$BIN_LINK"

echo "=== Starting gateway ==="
systemctl --user start openclaw-gateway

sleep 3
systemctl --user status openclaw-gateway --no-pager | head -5
echo ""
echo "=== Deployed $(openclaw --version) ==="

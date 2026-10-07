#!/usr/bin/env bash
# outreach-session-hook.sh — Called by the outreach-session-end hook handler
#
# Usage: outreach-session-hook.sh <session-id> <target-number> [session-file]
#
# 1. Reads the session transcript (JSONL)
# 2. Calls Gemini Flash to summarize
# 3. Stores summary in KB workspace
# 4. Calls outreach.sh end for cleanup (binding, pairing, queue drain)
# 5. Notifies operator via WhatsApp DM
#
set -euo pipefail

SESSION_ID="${1:?Missing session-id}"
TARGET="${2:?Missing target-number}"
SESSION_FILE="${3:-}"

OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OUTREACH_DIR="$OPENCLAW_DIR/.outreach"
SESSIONS_FILE="$OUTREACH_DIR/sessions.json"
KB_DIR="$OPENCLAW_DIR/workspaces/kb"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTREACH_SCRIPT="$SCRIPTS_DIR/outreach.sh"

# Google API key for Gemini calls (use first key from config)
GEMINI_API_KEY="${GOOGLE_API_KEY:?Missing GOOGLE_API_KEY}"
GEMINI_MODEL="gemini-2.5-flash-lite"
GEMINI_URL="https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}"

OPERATOR_PHONE="${OUTREACH_OPERATOR_PHONE:-$(jq -r '[.commands.ownerAllowFrom[]? | select(startswith("whatsapp:")) | ltrimstr("whatsapp:")][0] // ""' "$OPENCLAW_DIR/openclaw.json" 2>/dev/null || true)}"

log() { echo "[outreach-hook] $(date -u +%H:%M:%S) $*"; }
err() { echo "[outreach-hook] ERROR: $*" >&2; }

# --- Read session metadata ---

read_session_field() {
  local field="$1"
  jq -r --arg id "$SESSION_ID" --arg f "$field" \
    '.sessions[] | select(.id == $id) | .[$f] // ""' \
    "$SESSIONS_FILE" 2>/dev/null
}

TAG=$(read_session_field "tag")
TOPIC=$(read_session_field "topic")
AGENT_ID=$(read_session_field "agentId")

if [ -z "$TAG" ]; then
  TAG="outreach"
fi

log "Processing session $SESSION_ID: target=$TARGET tag=$TAG topic=$TOPIC"

# --- Find and read transcript ---

find_transcript() {
  if [ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ]; then
    echo "$SESSION_FILE"
    return
  fi
  return 1
}

TRANSCRIPT_FILE=$(find_transcript 2>/dev/null || true)

if [ -z "$TRANSCRIPT_FILE" ] || [ ! -f "$TRANSCRIPT_FILE" ]; then
  log "No transcript file found, running cleanup without summary"
  bash "$OUTREACH_SCRIPT" end "$SESSION_ID"

  # Notify operator
  openclaw message send \
    --channel whatsapp \
    --target "$OPERATOR_PHONE" \
    --message "Outreach session with $TARGET completed (tag: $TAG). No transcript found for summary." \
    2>/dev/null || true
  exit 0
fi

log "Reading transcript from: $TRANSCRIPT_FILE"

# Extract conversation from JSONL (role + content pairs)
# JSONL format has objects with "role" and "content" or "parts" fields
TRANSCRIPT_TEXT=$(python3 -c "
import json, sys

lines = []
try:
    with open('$TRANSCRIPT_FILE', 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                role = obj.get('role', obj.get('type', ''))
                content = obj.get('content', '')
                if isinstance(content, list):
                    parts = []
                    for p in content:
                        if isinstance(p, dict):
                            parts.append(p.get('text', str(p)))
                        else:
                            parts.append(str(p))
                    content = ' '.join(parts)
                elif isinstance(content, dict):
                    content = content.get('text', str(content))
                if content and role:
                    lines.append(f'{role}: {content[:500]}')
            except (json.JSONDecodeError, KeyError):
                continue
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)

# Take last 40 turns max
for line in lines[-40:]:
    print(line)
" 2>/dev/null || echo "(transcript parse failed)")

if [ -z "$TRANSCRIPT_TEXT" ] || [ "$TRANSCRIPT_TEXT" = "(transcript parse failed)" ]; then
  log "Could not parse transcript, using raw tail"
  TRANSCRIPT_TEXT=$(tail -40 "$TRANSCRIPT_FILE" 2>/dev/null || echo "(empty)")
fi

TRANSCRIPT_LENGTH=$(echo "$TRANSCRIPT_TEXT" | wc -l)
log "Transcript: $TRANSCRIPT_LENGTH lines"

# --- Summarize via Gemini ---

SUMMARY_PROMPT="You are summarizing an outreach interview conversation. The interviewer (assistant) reached out to a person (user) on WhatsApp on behalf of the owner.

Topic: $TOPIC
Tag: $TAG
Target: $TARGET

Conversation transcript:
---
$TRANSCRIPT_TEXT
---

Write a structured summary with these sections:
1. **Summary** — 2-3 sentences describing the conversation and its outcome
2. **Key Points** — Bullet list of important information gathered
3. **Questions & Answers** — For each interview question, the question and a paraphrased answer

Be concise and factual. Use plain text (no markdown links)."

# Escape the prompt for JSON
SUMMARY_PROMPT_JSON=$(python3 -c "
import json, sys
sys.stdout.write(json.dumps(sys.stdin.read()))
" <<< "$SUMMARY_PROMPT")

GEMINI_BODY=$(cat <<JSONEOF
{
  "contents": [{"parts": [{"text": $SUMMARY_PROMPT_JSON}]}],
  "generationConfig": {"maxOutputTokens": 2048, "temperature": 0.3}
}
JSONEOF
)

log "Calling Gemini for summary..."
GEMINI_RESPONSE=$(curl -s -X POST "$GEMINI_URL" \
  -H "Content-Type: application/json" \
  -d "$GEMINI_BODY" \
  --max-time 30 2>/dev/null || echo '{"error":"curl failed"}')

SUMMARY=$(echo "$GEMINI_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    parts = data.get('candidates', [{}])[0].get('content', {}).get('parts', [])
    text = ' '.join(p.get('text', '') for p in parts)
    print(text.strip())
except Exception as e:
    print(f'(summary generation failed: {e})', file=sys.stderr)
    print('(summary unavailable)')
" 2>/dev/null || echo "(summary unavailable)")

log "Summary generated (${#SUMMARY} chars)"

# --- Store in KB ---

TODAY=$(date -u +"%Y-%m-%d")
KB_OUTREACH_DIR="$KB_DIR/outreach"
mkdir -p "$KB_OUTREACH_DIR"

KB_FILE="$KB_OUTREACH_DIR/${TODAY}-${TAG}-$(echo "$TARGET" | tr '+' 'p').md"

cat > "$KB_FILE" <<KBEOF
---
title: "Outreach Interview: $TARGET — $TOPIC"
tag: $TAG
source: outreach-interview
target: "$TARGET"
date: $TODAY
agent: ${AGENT_ID:-outreach}
session_id: $SESSION_ID
---

$SUMMARY

---

*Auto-generated from outreach session $SESSION_ID on $TODAY*
KBEOF

log "Summary stored in KB: $KB_FILE"

# --- Cleanup via outreach.sh ---

log "Running cleanup..."
bash "$OUTREACH_SCRIPT" end "$SESSION_ID" 2>&1 || {
  err "Cleanup failed for session $SESSION_ID"
}

# --- Notify operator ---

NOTIFY_MSG="Outreach interview completed.

*Target:* $TARGET
*Topic:* $TOPIC
*Tag:* $TAG
*Turns:* $TRANSCRIPT_LENGTH

Summary stored in KB."

openclaw message send \
  --channel whatsapp \
  --target "$OPERATOR_PHONE" \
  --message "$NOTIFY_MSG" \
  2>/dev/null || log "Failed to send operator notification"

log "Done processing session $SESSION_ID"

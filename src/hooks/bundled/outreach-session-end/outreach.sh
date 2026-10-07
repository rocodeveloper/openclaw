#!/usr/bin/env bash
# outreach.sh — Outreach Interview Session Manager
#
# Usage:
#   outreach.sh start --to "+15551234567" --topic "Quarterly check-in" --tag "q2-feedback" \
#                      [--questions "Q1|Q2|Q3"] [--max-turns 20] [--agent outreach]
#   outreach.sh list
#   outreach.sh cancel <session-id>
#   outreach.sh cancel --all --target "+15551234567"
#   outreach.sh cleanup   # expire stale sessions, drain queues
#
set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG="$OPENCLAW_DIR/openclaw.json"
OUTREACH_DIR="$OPENCLAW_DIR/.outreach"
SESSIONS_FILE="$OUTREACH_DIR/sessions.json"
TEMP_PAIRINGS_FILE="$OUTREACH_DIR/temp-pairings.json"
ALLOWFROM_FILE="$OPENCLAW_DIR/credentials/whatsapp-default-allowFrom.json"
LOCKFILE="$OUTREACH_DIR/.lock"

DEFAULT_AGENT="outreach"
DEFAULT_MAX_TURNS=20
STALE_ACTIVE_HOURS=4
STALE_QUEUED_HOURS=24

# --- Helpers ---

log() { echo "[outreach] $(date -u +%H:%M:%S) $*"; }
err() { echo "[outreach] ERROR: $*" >&2; }
die() { err "$@"; exit 1; }

acquire_lock() {
  local max_wait=10 waited=0
  while ! mkdir "$LOCKFILE" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -ge "$max_wait" ]; then
      die "Could not acquire lock after ${max_wait}s. Stale lock? rm -rf $LOCKFILE"
    fi
    sleep 1
  done
  trap 'rm -rf "$LOCKFILE"' EXIT
}

release_lock() {
  rm -rf "$LOCKFILE"
  trap - EXIT
}

now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

hours_ago_epoch() {
  local hours="$1"
  echo $(( $(date -u +%s) - hours * 3600 ))
}

iso_to_epoch() {
  date -d "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null || echo 0
}

# Atomic JSON file write (write to temp, then rename)
write_json() {
  local file="$1" content="$2"
  local tmp="${file}.tmp.$$"
  echo "$content" > "$tmp"
  mv -f "$tmp" "$file"
}

# --- AllowFrom management ---

is_user_in_allowfrom() {
  local number="$1"
  if [ ! -f "$ALLOWFROM_FILE" ]; then
    return 1
  fi
  jq -e --arg n "$number" '.allowFrom | index($n) != null' "$ALLOWFROM_FILE" >/dev/null 2>&1
}

add_to_allowfrom() {
  local number="$1"
  if is_user_in_allowfrom "$number"; then
    return 0
  fi
  if [ ! -f "$ALLOWFROM_FILE" ]; then
    write_json "$ALLOWFROM_FILE" '{"version":1,"allowFrom":[]}'
  fi
  local updated
  updated=$(jq --arg n "$number" '.allowFrom += [$n]' "$ALLOWFROM_FILE")
  write_json "$ALLOWFROM_FILE" "$updated"
  log "Added $number to allowFrom"
}

remove_from_allowfrom() {
  local number="$1"
  if [ ! -f "$ALLOWFROM_FILE" ]; then
    return 0
  fi
  local updated
  updated=$(jq --arg n "$number" '.allowFrom = [.allowFrom[] | select(. != $n)]' "$ALLOWFROM_FILE")
  write_json "$ALLOWFROM_FILE" "$updated"
  log "Removed $number from allowFrom"
}

# --- Binding management ---

add_outreach_binding() {
  local peer_id="$1" comment="$2"
  # Insert at position 0 (top) of bindings array so it takes precedence
  # peer.id must be E.164 format (e.g., "+15551234567") — that's what the WhatsApp
  # plugin uses for DM peer resolution via resolvePeerId() → sender.e164
  local updated
  updated=$(jq --arg aid "$DEFAULT_AGENT" --arg pid "$peer_id" --arg comment "$comment" \
    '.bindings = [{"agentId": $aid, "comment": $comment, "match": {"channel": "whatsapp", "peer": {"kind": "direct", "id": $pid}}}] + .bindings' \
    "$CONFIG")
  write_json "$CONFIG" "$updated"
  log "Injected binding for $peer_id (comment: $comment)"
}

remove_outreach_binding() {
  local comment="$1"
  local updated
  updated=$(jq --arg c "$comment" '.bindings = [.bindings[] | select(.comment != $c)]' "$CONFIG")
  write_json "$CONFIG" "$updated"
  log "Removed binding with comment: $comment"
}

# --- Session tracking ---

get_active_session_for_target() {
  local number="$1"
  jq -r --arg n "$number" \
    '.sessions[] | select(.targetNumber == $n and .status == "active") | .id' \
    "$SESSIONS_FILE" 2>/dev/null | head -1
}

get_next_queued_session() {
  local number="$1"
  jq -r --arg n "$number" \
    '[.sessions[] | select(.targetNumber == $n and .status == "queued")] | sort_by(.queuedAt) | .[0] // empty | .id' \
    "$SESSIONS_FILE" 2>/dev/null
}

add_session() {
  local id="$1" target="$2" agent="$3" tag="$4" topic="$5" questions="$6" max_turns="$7" status="$8"
  local now
  now=$(now_iso)
  local binding_comment="outreach:temp:$id"

  local started_at="null"
  local queued_at="null"
  local queued_behind="null"
  if [ "$status" = "active" ]; then
    started_at="\"$now\""
  elif [ "$status" = "queued" ]; then
    queued_at="\"$now\""
    local active_id
    active_id=$(get_active_session_for_target "$target")
    if [ -n "$active_id" ]; then
      queued_behind="\"$active_id\""
    fi
  fi

  local updated
  updated=$(jq --arg id "$id" --arg target "$target" --arg agent "$agent" \
    --arg tag "$tag" --arg topic "$topic" --arg questions "$questions" \
    --argjson maxTurns "$max_turns" --arg status "$status" \
    --argjson startedAt "$started_at" --argjson queuedAt "$queued_at" \
    --argjson queuedBehind "$queued_behind" --arg bc "$binding_comment" \
    '.sessions += [{
      id: $id,
      targetNumber: $target,
      agentId: $agent,
      tag: $tag,
      topic: $topic,
      questions: ($questions | split("|")),
      status: $status,
      startedAt: $startedAt,
      queuedAt: $queuedAt,
      queuedBehind: $queuedBehind,
      maxTurns: $maxTurns,
      turnCount: 0,
      bindingComment: $bc
    }]' "$SESSIONS_FILE")
  write_json "$SESSIONS_FILE" "$updated"
}

update_session_status() {
  local id="$1" new_status="$2"
  local now
  now=$(now_iso)
  local updated
  updated=$(jq --arg id "$id" --arg s "$new_status" --arg now "$now" \
    '(.sessions[] | select(.id == $id)) |=
      (if $s == "active" then .status = $s | .startedAt = $now | .queuedAt = null | .queuedBehind = null
       else .status = $s end)' \
    "$SESSIONS_FILE")
  write_json "$SESSIONS_FILE" "$updated"
}

# --- Temp pairing tracking ---

add_temp_pairing() {
  local number="$1" session_id="$2" tag="$3" was_already_paired="$4"
  local now
  now=$(now_iso)
  local updated
  updated=$(jq --arg n "$number" --arg sid "$session_id" --arg tag "$tag" \
    --argjson wap "$was_already_paired" --arg now "$now" \
    '.entries += [{
      number: $n,
      sessionId: $sid,
      tag: $tag,
      createdAt: $now,
      wasAlreadyPaired: $wap
    }]' "$TEMP_PAIRINGS_FILE")
  write_json "$TEMP_PAIRINGS_FILE" "$updated"
}

was_already_paired_for_session() {
  local session_id="$1"
  jq -e --arg sid "$session_id" \
    '.entries[] | select(.sessionId == $sid) | .wasAlreadyPaired' \
    "$TEMP_PAIRINGS_FILE" 2>/dev/null
}

remove_temp_pairing() {
  local session_id="$1"
  local updated
  updated=$(jq --arg sid "$session_id" \
    '.entries = [.entries[] | select(.sessionId != $sid)]' \
    "$TEMP_PAIRINGS_FILE")
  write_json "$TEMP_PAIRINGS_FILE" "$updated"
}

# --- Core: start an outreach session ---

do_start_session() {
  local target="$1" agent="$2" tag="$3" topic="$4" questions="$5" max_turns="$6" tone="$7" intro="$8"
  local session_id jid binding_comment was_paired

  session_id=$(uuidgen)
  binding_comment="outreach:temp:$session_id"

  # Check allowFrom status before modifying
  if is_user_in_allowfrom "$target"; then
    was_paired=true
  else
    was_paired=false
  fi

  # 1. Add to allowFrom if needed
  add_to_allowfrom "$target"

  # 2. Track temp pairing
  add_temp_pairing "$target" "$session_id" "$tag" "$was_paired"

  # 3. Inject binding (peer.id must be E.164 format for WhatsApp DMs)
  DEFAULT_AGENT="$agent"
  add_outreach_binding "$target" "$binding_comment"

  # 4. Track session
  add_session "$session_id" "$target" "$agent" "$tag" "$topic" "$questions" "$max_turns" "active"

  # 5. Write briefing file to outreach workspace
  #    The agent reads this at bootstrap (via AGENTS.md instructions).
  #    File is per-target so multiple outreach sessions don't collide.
  local briefing_dir="$OPENCLAW_DIR/workspaces/outreach/briefings"
  mkdir -p "$briefing_dir"
  local briefing_file="$briefing_dir/$(echo "$target" | tr '+' 'p').md"

  {
    echo "# Active Outreach Briefing"
    echo ""
    echo "- **Session ID:** $session_id"
    echo "- **Target:** $target"
    echo "- **Topic:** $topic"
    echo "- **Tag:** $tag"
    echo "- **Max turns:** $max_turns"
    echo ""
    if [ -n "$tone" ] && [ "$tone" != "-" ]; then
      echo "## Tone & Attitude"
      echo ""
      echo "$tone"
      echo ""
    fi
    if [ -n "$questions" ] && [ "$questions" != "-" ]; then
      echo "## Questions to Cover"
      echo ""
      IFS='|' read -ra QARR <<< "$questions"
      for q in "${QARR[@]}"; do
        echo "- $q"
      done
      echo ""
    fi
    echo "## Instructions"
    echo ""
    echo "Introduce yourself and begin the interview. When you're done, include *[Session complete]* in your final message."
  } > "$briefing_file"

  log "Wrote briefing to $briefing_file"

  # 6. Wait for gateway config reload (chokidar debounce is 300ms)
  sleep 1

  # 7. Simulate a user turn so the agent composes the intro naturally.
  #    We call the gateway agent RPC directly with the correct session key
  #    (matching the per-channel-peer format that inbound WhatsApp uses).
  #    This creates the session, the agent reads the briefing file and responds,
  #    and subsequent real messages from the user continue in the SAME session.
  local session_key="agent:${agent}:whatsapp:direct:${target}"

  local agent_prompt="This is an outreach session. Read the briefing file at briefings/$(echo "$target" | tr '+' 'p').md and send a first message to start the conversation."

  if [ -n "$intro" ] && [ "$intro" != "-" ]; then
    agent_prompt="Send this exact message to $target:

$intro"
  fi

  # Escape for JSON
  local prompt_json
  prompt_json=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$agent_prompt")
  local sk_json
  sk_json=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))" <<< "$session_key")

  local idem_key
  idem_key=$(uuidgen)
  local params="{\"message\":${prompt_json},\"agentId\":\"${agent}\",\"sessionKey\":${sk_json},\"to\":\"${target}\",\"channel\":\"whatsapp\",\"deliver\":true,\"idempotencyKey\":\"${idem_key}\"}"

  log "Starting outreach session $session_id to $target (topic: $topic, tag: $tag)"

  openclaw gateway call agent \
    --params "$params" \
    --expect-final \
    --timeout 60000 \
    2>&1 || {
      err "Failed to send intro. Cleaning up..."
      remove_outreach_binding "$binding_comment"
      if [ "$was_paired" = "false" ]; then
        remove_from_allowfrom "$target"
      fi
      update_session_status "$session_id" "failed"
      remove_temp_pairing "$session_id"
      rm -f "$briefing_file"
      die "Outreach start failed for $target"
    }

  log "Session $session_id started successfully"
  echo "$session_id"
}

# --- Commands ---

cmd_start() {
  local target="" topic="" tag="" questions="" max_turns="$DEFAULT_MAX_TURNS" agent="$DEFAULT_AGENT"
  local tone="" intro=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to)        target="$2"; shift 2 ;;
      --topic)     topic="$2"; shift 2 ;;
      --tag)       tag="$2"; shift 2 ;;
      --questions) questions="$2"; shift 2 ;;
      --max-turns) max_turns="$2"; shift 2 ;;
      --agent)     agent="$2"; shift 2 ;;
      --tone)      tone="$2"; shift 2 ;;
      --intro)     intro="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [ -z "$target" ] && die "Missing --to <phone>"
  [ -z "$topic" ] && die "Missing --topic <description>"
  [ -z "$tag" ] && die "Missing --tag <kb-tag>"

  acquire_lock

  # Queue guard: check for active session to this target
  local active_id
  active_id=$(get_active_session_for_target "$target")
  if [ -n "$active_id" ]; then
    log "Active session $active_id exists for $target — queueing new request"
    local queued_id
    queued_id=$(uuidgen)
    add_session "$queued_id" "$target" "$agent" "$tag" "$topic" "$questions" "$max_turns" "queued"
    release_lock
    log "Queued session $queued_id (behind $active_id)"
    echo "queued:$queued_id"
    return 0
  fi

  do_start_session "$target" "$agent" "$tag" "$topic" "$questions" "$max_turns" "$tone" "$intro"
  release_lock
}

cmd_list() {
  if [ ! -f "$SESSIONS_FILE" ]; then
    echo "No sessions file found."
    return 0
  fi

  echo "=== Active Sessions ==="
  jq -r '.sessions[] | select(.status == "active") |
    "  \(.id)  \(.targetNumber)  tag=\(.tag)  started=\(.startedAt)  turns=\(.turnCount)/\(.maxTurns)"' \
    "$SESSIONS_FILE" 2>/dev/null || echo "  (none)"

  echo ""
  echo "=== Queued Sessions ==="
  jq -r '.sessions[] | select(.status == "queued") |
    "  \(.id)  \(.targetNumber)  tag=\(.tag)  queued=\(.queuedAt)  behind=\(.queuedBehind // "?")"' \
    "$SESSIONS_FILE" 2>/dev/null || echo "  (none)"

  echo ""
  echo "=== Recent Completed ==="
  jq -r '[.sessions[] | select(.status == "completed" or .status == "expired")] | .[-5:] | .[] |
    "  \(.id)  \(.targetNumber)  tag=\(.tag)  status=\(.status)"' \
    "$SESSIONS_FILE" 2>/dev/null || echo "  (none)"
}

cmd_cancel() {
  local session_id="" target="" cancel_all=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all)    cancel_all=true; shift ;;
      --target) target="$2"; shift 2 ;;
      *)        session_id="$1"; shift ;;
    esac
  done

  acquire_lock

  if [ "$cancel_all" = true ] && [ -n "$target" ]; then
    # Cancel all queued + active for this target
    local ids
    ids=$(jq -r --arg n "$target" \
      '.sessions[] | select(.targetNumber == $n and (.status == "active" or .status == "queued")) | .id' \
      "$SESSIONS_FILE" 2>/dev/null)

    for id in $ids; do
      _cancel_single "$id"
    done
    release_lock
    return 0
  fi

  [ -z "$session_id" ] && die "Usage: outreach.sh cancel <session-id> | --all --target <phone>"
  _cancel_single "$session_id"
  release_lock
}

_cancel_single() {
  local id="$1"
  local status
  status=$(jq -r --arg id "$id" '.sessions[] | select(.id == $id) | .status' "$SESSIONS_FILE" 2>/dev/null)

  case "$status" in
    active)
      local target bc
      target=$(jq -r --arg id "$id" '.sessions[] | select(.id == $id) | .targetNumber' "$SESSIONS_FILE")
      bc=$(jq -r --arg id "$id" '.sessions[] | select(.id == $id) | .bindingComment' "$SESSIONS_FILE")

      remove_outreach_binding "$bc"

      local was_paired
      was_paired=$(was_already_paired_for_session "$id" 2>/dev/null || echo "false")
      if [ "$was_paired" = "false" ]; then
        remove_from_allowfrom "$target"
      fi
      remove_temp_pairing "$id"
      # Remove briefing file
      rm -f "$OPENCLAW_DIR/workspaces/outreach/briefings/$(echo "$target" | tr '+' 'p').md" 2>/dev/null
      update_session_status "$id" "cancelled"
      log "Cancelled active session $id"
      ;;
    queued)
      update_session_status "$id" "cancelled"
      remove_temp_pairing "$id"
      log "Cancelled queued session $id"
      ;;
    *)
      log "Session $id has status '$status' — nothing to cancel"
      ;;
  esac
}

# --- Session end: called by the session-end hook ---

cmd_end() {
  local session_id="$1"

  acquire_lock

  local target bc
  target=$(jq -r --arg id "$session_id" '.sessions[] | select(.id == $id) | .targetNumber' "$SESSIONS_FILE" 2>/dev/null)
  bc=$(jq -r --arg id "$session_id" '.sessions[] | select(.id == $id) | .bindingComment' "$SESSIONS_FILE" 2>/dev/null)

  if [ -z "$target" ] || [ "$target" = "null" ]; then
    release_lock
    die "Session $session_id not found"
  fi

  # 1. Remove binding and briefing file
  remove_outreach_binding "$bc"
  local briefing_file="$OPENCLAW_DIR/workspaces/outreach/briefings/$(echo "$target" | tr '+' 'p').md"
  rm -f "$briefing_file" 2>/dev/null

  # 2. Remove temp pairing if needed
  local was_paired
  was_paired=$(was_already_paired_for_session "$session_id" 2>/dev/null || echo "false")
  if [ "$was_paired" = "false" ]; then
    remove_from_allowfrom "$target"
  fi
  remove_temp_pairing "$session_id"

  # 3. Mark session completed
  update_session_status "$session_id" "completed"
  log "Session $session_id completed for $target"

  # 4. Drain queue — start next queued session for this target
  local next_id
  next_id=$(get_next_queued_session "$target")
  if [ -n "$next_id" ]; then
    log "Draining queue: starting session $next_id for $target"
    local agent tag topic questions max_turns
    agent=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .agentId' "$SESSIONS_FILE")
    tag=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .tag' "$SESSIONS_FILE")
    topic=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .topic' "$SESSIONS_FILE")
    questions=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .questions | join("|")' "$SESSIONS_FILE")
    max_turns=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .maxTurns' "$SESSIONS_FILE")

    # Remove the queued entry (we'll re-create it as active)
    local updated
    updated=$(jq --arg id "$next_id" '.sessions = [.sessions[] | select(.id != $id)]' "$SESSIONS_FILE")
    write_json "$SESSIONS_FILE" "$updated"

    release_lock
    # Start the queued session (this re-acquires lock internally)
    do_start_session "$target" "$agent" "$tag" "$topic" "$questions" "$max_turns"
  else
    release_lock
  fi
}

# --- Cleanup: expire stale sessions ---

cmd_cleanup() {
  acquire_lock

  local stale_active_epoch stale_queued_epoch
  stale_active_epoch=$(hours_ago_epoch "$STALE_ACTIVE_HOURS")
  stale_queued_epoch=$(hours_ago_epoch "$STALE_QUEUED_HOURS")

  # Find stale active sessions
  local stale_active
  stale_active=$(jq -r '.sessions[] | select(.status == "active") | .id + "|" + .startedAt + "|" + .targetNumber + "|" + .bindingComment' \
    "$SESSIONS_FILE" 2>/dev/null || true)

  local expired_targets=()

  while IFS='|' read -r id started_at target bc; do
    [ -z "$id" ] && continue
    local started_epoch
    started_epoch=$(iso_to_epoch "$started_at")
    if [ "$started_epoch" -lt "$stale_active_epoch" ]; then
      log "Expiring stale active session $id (started $started_at)"
      remove_outreach_binding "$bc"
      local was_paired
      was_paired=$(was_already_paired_for_session "$id" 2>/dev/null || echo "false")
      if [ "$was_paired" = "false" ]; then
        remove_from_allowfrom "$target"
      fi
      remove_temp_pairing "$id"
      update_session_status "$id" "expired"
      expired_targets+=("$target")
    fi
  done <<< "$stale_active"

  # Find stale queued sessions (>24h)
  local stale_queued
  stale_queued=$(jq -r '.sessions[] | select(.status == "queued") | .id + "|" + (.queuedAt // "") + "|" + .targetNumber' \
    "$SESSIONS_FILE" 2>/dev/null || true)

  while IFS='|' read -r id queued_at target; do
    [ -z "$id" ] && continue
    [ -z "$queued_at" ] && continue
    local queued_epoch
    queued_epoch=$(iso_to_epoch "$queued_at")
    if [ "$queued_epoch" -lt "$stale_queued_epoch" ]; then
      log "Expiring stale queued session $id (queued $queued_at)"
      update_session_status "$id" "expired-queued"
      remove_temp_pairing "$id"
    fi
  done <<< "$stale_queued"

  # Drain queue for targets whose active session was just expired
  release_lock

  for target in "${expired_targets[@]}"; do
    local next_id
    next_id=$(get_next_queued_session "$target" 2>/dev/null || true)
    if [ -n "$next_id" ]; then
      log "Draining queue after expiry: starting session $next_id for $target"
      local agent tag topic questions max_turns
      acquire_lock
      agent=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .agentId' "$SESSIONS_FILE")
      tag=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .tag' "$SESSIONS_FILE")
      topic=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .topic' "$SESSIONS_FILE")
      questions=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .questions | join("|")' "$SESSIONS_FILE")
      max_turns=$(jq -r --arg id "$next_id" '.sessions[] | select(.id == $id) | .maxTurns' "$SESSIONS_FILE")

      local updated
      updated=$(jq --arg id "$next_id" '.sessions = [.sessions[] | select(.id != $id)]' "$SESSIONS_FILE")
      write_json "$SESSIONS_FILE" "$updated"
      release_lock

      do_start_session "$target" "$agent" "$tag" "$topic" "$questions" "$max_turns"
    fi
  done

  log "Cleanup complete"
}

# --- Lookup: find session by target number (for hooks) ---

cmd_find() {
  local target="$1"
  jq -r --arg n "$target" \
    '.sessions[] | select(.targetNumber == $n and .status == "active") | .id' \
    "$SESSIONS_FILE" 2>/dev/null | head -1
}

# --- Main ---

case "${1:-help}" in
  start)   shift; cmd_start "$@" ;;
  list)    cmd_list ;;
  cancel)  shift; cmd_cancel "$@" ;;
  end)     shift; cmd_end "$1" ;;
  cleanup) cmd_cleanup ;;
  find)    shift; cmd_find "$1" ;;
  help|*)
    echo "Usage: outreach.sh <command> [options]"
    echo ""
    echo "Commands:"
    echo "  start    Start a new outreach session (or queue if one is active)"
    echo "  list     List all sessions (active, queued, recent)"
    echo "  cancel   Cancel a session (active or queued)"
    echo "  end      End an active session (called by session-end hook)"
    echo "  cleanup  Expire stale sessions and drain queues"
    echo "  find     Find active session ID by target number"
    echo ""
    echo "Start options:"
    echo "  --to <phone>          Target phone number (E.164)"
    echo "  --topic <text>        Interview topic/description"
    echo "  --tag <tag>           KB tag for the summary"
    echo "  --questions <q1|q2>   Pipe-separated questions"
    echo "  --tone <text>         How the agent should behave (e.g. 'playful, warm, teasing')"
    echo "  --intro <text>        Custom intro message (overrides default)"
    echo "  --max-turns <n>       Max turns (default: $DEFAULT_MAX_TURNS)"
    echo "  --agent <id>          Agent ID (default: $DEFAULT_AGENT)"
    ;;
esac

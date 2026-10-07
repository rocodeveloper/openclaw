---
name: outreach-session-end
description: "Summarize outreach interviews and clean up on session reset"
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "events": ["command:new", "command:reset"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Outreach Session End Hook

Fires when a session resets. If the session belongs to the outreach agent:

1. Reads the session transcript
2. Summarizes via LLM (Gemini Flash)
3. Stores summary in KB with the configured tag
4. Calls `outreach.sh end` to clean up bindings, pairings, and drain the queue

`outreach-session-hook.sh` and `outreach.sh` ship next to this file. Both use `$OPENCLAW_STATE_DIR/.outreach`, `$OPENCLAW_STATE_DIR/workspaces/kb`, and the `openclaw` CLI on `PATH`. The hook script needs `GOOGLE_API_KEY`. The operator notification goes to `OUTREACH_OPERATOR_PHONE`, or to the first `whatsapp:` entry in `commands.ownerAllowFrom`.

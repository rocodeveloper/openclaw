import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveBundledHooksDir } from "../../bundled-dir.js";
import type { HookHandler } from "../../hooks.js";

const HOOK_NAME = "outreach-session-end";
const HOOK_SCRIPT_NAME = "outreach-session-hook.sh";
const HOOK_SCRIPT_TIMEOUT_MS = 120_000;

const log = createSubsystemLogger(`hooks/${HOOK_NAME}`);

type OutreachSessionRecord = { id?: string; targetNumber?: string; status?: string };
type SessionEntryLike = { sessionId?: unknown } | undefined;
type TranscriptScope = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

function parseAgentIdFromSessionKey(sessionKey: unknown): string | null {
  if (!sessionKey || typeof sessionKey !== "string") {
    return null;
  }
  const parts = sessionKey.split(":");
  if (parts.length < 2 || parts[0] !== "agent") {
    return null;
  }
  return parts[1] ?? null;
}

function parseTargetFromSessionKey(sessionKey: string): string | null {
  return sessionKey.match(/whatsapp:direct:(\+\d+)/)?.[1] ?? null;
}

function findSessionIdByTarget(stateDir: string, target: string): string | null {
  try {
    const store = JSON.parse(
      readFileSync(path.join(stateDir, ".outreach", "sessions.json"), "utf-8"),
    ) as { sessions: OutreachSessionRecord[] };
    const session = store.sessions.find(
      (entry) => entry.targetNumber === target && entry.status === "active",
    );
    return session?.id || null;
  } catch {
    return null;
  }
}

function resolveTranscriptScope(
  agentId: string,
  sessionKey: string,
  context: Record<string, unknown>,
): TranscriptScope | null {
  const entry = (context.previousSessionEntry || context.sessionEntry) as SessionEntryLike;
  const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId.trim() : "";
  if (!sessionId) {
    return null;
  }
  const storePath =
    typeof context.storePath === "string" && context.storePath.trim()
      ? context.storePath.trim()
      : resolveSessionStorePathCore((context.cfg as OpenClawConfig | undefined)?.session?.store, {
          agentId,
        });
  return { agentId, sessionId, sessionKey, storePath };
}

function toTranscriptLine(event: unknown): string | null {
  const message =
    event && typeof event === "object" && (event as { type?: unknown }).type === "message"
      ? (event as { message?: { role?: unknown; content?: unknown } }).message
      : undefined;
  if (typeof message?.role !== "string" || message.content === undefined) {
    return null;
  }
  return JSON.stringify({ role: message.role, content: message.content });
}

async function exportTranscript(scope: TranscriptScope): Promise<string | null> {
  const lines = loadTranscriptEventsSync(scope)
    .map(toTranscriptLine)
    .filter((line): line is string => line !== null);
  if (lines.length === 0) {
    return null;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${HOOK_NAME}-`));
  const file = path.join(directory, "transcript.jsonl");
  await fs.writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

function resolveHookScriptPath(): string | null {
  const bundledHooksDir = resolveBundledHooksDir();
  return bundledHooksDir ? path.join(bundledHooksDir, HOOK_NAME, HOOK_SCRIPT_NAME) : null;
}

function runHookScript(script: string, args: string[], stateDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      [script, ...args],
      {
        timeout: HOOK_SCRIPT_TIMEOUT_MS,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      },
      (err, stdout, stderr) => {
        if (stdout) {
          log.info(`hook-script stdout: ${stdout.trim()}`);
        }
        if (stderr) {
          log.info(`hook-script stderr: ${stderr.trim()}`);
        }
        if (err) {
          log.warn(`hook-script failed: ${err.message}`);
          reject(err);
          return;
        }
        resolve();
      },
    );
  });
}

const handleOutreachSessionEnd: HookHandler = async (event) => {
  if (event.type !== "command") {
    return;
  }
  if (event.action !== "new" && event.action !== "reset") {
    return;
  }
  if (parseAgentIdFromSessionKey(event.sessionKey) !== "outreach") {
    return;
  }

  const target = parseTargetFromSessionKey(event.sessionKey);
  if (!target) {
    log.info(`Could not parse target from session key: ${event.sessionKey}`);
    return;
  }

  const stateDir = resolveStateDir();
  const sessionId = findSessionIdByTarget(stateDir, target);
  if (!sessionId) {
    log.info(`No active outreach session found for target: ${target}`);
    return;
  }

  const script = resolveHookScriptPath();
  if (!script) {
    log.warn("Bundled hooks directory not found; skipping outreach session hook script");
    return;
  }

  log.info(`Outreach session reset detected: ${sessionId} target=${target}`);

  const scope = resolveTranscriptScope("outreach", event.sessionKey, event.context ?? {});
  let transcriptFile: string | null = null;
  try {
    transcriptFile = scope ? await exportTranscript(scope) : null;
  } catch (err) {
    log.warn(`Failed to export outreach transcript: ${(err as Error).message}`);
  }

  const args = transcriptFile ? [sessionId, target, transcriptFile] : [sessionId, target];
  try {
    await runHookScript(script, args, stateDir);
  } catch (err) {
    log.warn(`Failed to run outreach session hook script: ${(err as Error).message}`);
  } finally {
    if (transcriptFile) {
      await fs.rm(path.dirname(transcriptFile), { recursive: true, force: true });
    }
  }
};

export default handleOutreachSessionEnd;

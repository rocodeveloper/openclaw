import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createInternalHookEvent as createHookEvent } from "../../internal-hooks.js";

const exportedTranscripts = vi.hoisted(() => [] as string[]);
const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (err: null, stdout: string, stderr: string) => void,
    ) => {
      if (args[3]) {
        exportedTranscripts.push(readFileSync(args[3], "utf8"));
      }
      callback(null, "", "");
    },
  ),
);
const loadTranscriptEventsSyncMock = vi.hoisted(() => vi.fn((_scope: unknown): unknown[] => []));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>()),
  loadTranscriptEventsSync: loadTranscriptEventsSyncMock,
}));

const TARGET = "+15551234567";
const OUTREACH_SESSION_KEY = `agent:outreach:whatsapp:direct:${TARGET}`;

let handler: typeof import("./handler.js").default;
let stateDir: string;
let bundledHooksDir: string;

async function runWithEnv(event: ReturnType<typeof createHookEvent>) {
  await withEnvAsync(
    { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_BUNDLED_HOOKS_DIR: bundledHooksDir },
    async () => {
      await handler(event);
    },
  );
}

describe("outreach-session-end hook", () => {
  beforeAll(async () => {
    ({ default: handler } = await import("./handler.js"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "outreach-hook-"));
    bundledHooksDir = path.join(stateDir, "bundled");
    await fs.mkdir(path.join(stateDir, ".outreach"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, ".outreach", "sessions.json"),
      JSON.stringify({
        sessions: [
          { id: "outreach-1", targetNumber: TARGET, status: "active" },
          { id: "outreach-old", targetNumber: TARGET, status: "completed" },
        ],
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    execFileMock.mockClear();
    loadTranscriptEventsSyncMock.mockReset();
    loadTranscriptEventsSyncMock.mockReturnValue([]);
    exportedTranscripts.length = 0;
  });

  it("passes the exported session transcript to the bundled hook script", async () => {
    loadTranscriptEventsSyncMock.mockReturnValue([
      { type: "session", id: "header" },
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ]);
    await runWithEnv(
      createHookEvent("command", "reset", OUTREACH_SESSION_KEY, {
        previousSessionEntry: { sessionId: "session-1" },
        storePath: "/tmp/agent/sessions.sqlite",
      }),
    );

    expect(loadTranscriptEventsSyncMock).toHaveBeenCalledWith({
      agentId: "outreach",
      sessionId: "session-1",
      sessionKey: OUTREACH_SESSION_KEY,
      storePath: "/tmp/agent/sessions.sqlite",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe("bash");
    expect(args.slice(0, 3)).toEqual([
      path.join(bundledHooksDir, "outreach-session-end", "outreach-session-hook.sh"),
      "outreach-1",
      TARGET,
    ]);
    expect(exportedTranscripts).toEqual([
      '{"role":"user","content":"hello"}\n{"role":"assistant","content":[{"type":"text","text":"hi"}]}\n',
    ]);
    await expect(fs.access(args[3])).rejects.toThrow();
    expect((options as { env: NodeJS.ProcessEnv }).env.OPENCLAW_STATE_DIR).toBe(stateDir);
  });

  it("runs the hook script without a transcript when the session has no messages", async () => {
    await runWithEnv(
      createHookEvent("command", "new", OUTREACH_SESSION_KEY, {
        previousSessionEntry: { sessionId: "session-1" },
        storePath: "/tmp/agent/sessions.sqlite",
      }),
    );
    await runWithEnv(createHookEvent("command", "new", OUTREACH_SESSION_KEY, {}));

    expect(execFileMock.mock.calls.map(([, args]) => args.slice(1))).toEqual([
      ["outreach-1", TARGET],
      ["outreach-1", TARGET],
    ]);
  });

  it.each([
    ["another agent", createHookEvent("command", "new", `agent:main:whatsapp:direct:${TARGET}`)],
    [
      "an agent id that only contains outreach",
      createHookEvent("command", "new", `agent:outreach-bot:whatsapp:direct:${TARGET}`),
    ],
    [
      "a non-agent session key",
      createHookEvent("command", "new", `outreach:whatsapp:direct:${TARGET}`),
    ],
    ["another command", createHookEvent("command", "stop", OUTREACH_SESSION_KEY)],
    ["another event type", createHookEvent("session", "reset", OUTREACH_SESSION_KEY)],
    [
      "an outreach session without an active record",
      createHookEvent("command", "new", "agent:outreach:whatsapp:direct:+15557654321"),
    ],
  ])("ignores %s", async (_label, event) => {
    await runWithEnv(event);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

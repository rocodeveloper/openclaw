import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { parseSessionScopeConfig } from "./src/config.js";
import { beforeToolCall, LAST, resolveExecEnv } from "./src/gate-env.js";

const GATE_AGENTS = new Set(["group-agent", "second-group-agent"]);
const GROUP_KEY = "agent:group-agent:whatsapp:group:120363000000000000@g.us";
const SENDER = "+15551234567";

describe("session-scope config", () => {
  it("reads gateAgents and ignores blank or non-string entries", () => {
    expect(
      parseSessionScopeConfig({ gateAgents: [" group-agent ", "", 3, "second-group-agent"] })
        .gateAgents,
    ).toEqual(GATE_AGENTS);
  });

  it("gates no agent when the list is absent", () => {
    expect(parseSessionScopeConfig(undefined).gateAgents.size).toBe(0);
    expect(parseSessionScopeConfig({}).gateAgents.size).toBe(0);
    expect(parseSessionScopeConfig({ gateAgents: "group-agent" }).gateAgents.size).toBe(0);
  });
});

describe("session-scope beforeToolCall", () => {
  it("replaces the model env instead of merging it", () => {
    const result = beforeToolCall(
      GATE_AGENTS,
      {
        toolName: "exec",
        params: {
          command: "gate kb list",
          env: { GATE_SENDER: "+15557654321", GATE_AGENT: "main", PATH: "/tmp/evil" },
        },
      },
      { agentId: "group-agent", sessionKey: GROUP_KEY, requester: { senderId: SENDER } },
    );

    expect(result?.params).toEqual({
      command: "gate kb list",
      env: {
        GATE_SENDER: SENDER,
        GATE_GROUP: "120363000000000000@g.us",
        GATE_AGENT: "group-agent",
        GATE_SESSION: GROUP_KEY,
      },
    });
  });

  it("takes the sender only from the requester E164", () => {
    const fromParams = beforeToolCall(
      GATE_AGENTS,
      { toolName: "bash", params: { env: { GATE_SENDER: SENDER }, sender: SENDER } },
      {
        agentId: "second-group-agent",
        sessionKey: "agent:second-group-agent:whatsapp:group:1-2@g.us",
      },
    );
    expect(fromParams?.params.env.GATE_SENDER).toBe("");

    for (const senderId of ["15551234567", "120363000000000000@g.us", "12345"]) {
      const invalid = beforeToolCall(
        GATE_AGENTS,
        { toolName: "exec", params: {} },
        { agentId: "group-agent", sessionKey: GROUP_KEY, requester: { senderId } },
      );
      expect(invalid?.params.env.GATE_SENDER).toBe("");
    }

    const trimmed = beforeToolCall(
      GATE_AGENTS,
      { toolName: "exec", params: {} },
      { agentId: "group-agent", sessionKey: GROUP_KEY, requester: { senderId: ` ${SENDER} ` } },
    );
    expect(trimmed?.params.env.GATE_SENDER).toBe(SENDER);
  });

  it("leaves non-gate agents untouched", () => {
    const event = { toolName: "exec", params: { command: "ls", env: { GATE_SENDER: SENDER } } };
    expect(
      beforeToolCall(GATE_AGENTS, event, { agentId: "main", sessionKey: "agent:main:main" }),
    ).toBeUndefined();
    expect(
      beforeToolCall(GATE_AGENTS, event, {
        agentId: "main",
        sessionKey: GROUP_KEY,
        requester: { senderId: SENDER },
      }),
    ).toBeUndefined();
    expect(
      beforeToolCall(new Set(), event, {
        agentId: "group-agent",
        sessionKey: GROUP_KEY,
        requester: { senderId: SENDER },
      }),
    ).toBeUndefined();
  });

  it("handles only exec and bash", () => {
    const ctx = { agentId: "group-agent", sessionKey: GROUP_KEY, requester: { senderId: SENDER } };
    expect(beforeToolCall(GATE_AGENTS, { toolName: "exec", params: {} }, ctx)).toBeDefined();
    expect(beforeToolCall(GATE_AGENTS, { toolName: "bash", params: {} }, ctx)).toBeDefined();
    for (const toolName of ["read", "write", "process", "web_fetch"]) {
      expect(beforeToolCall(GATE_AGENTS, { toolName, params: {} }, ctx)).toBeUndefined();
    }
  });
});

describe("session-scope resolveExecEnv", () => {
  it("leaves GATE_SENDER out for gate agents", () => {
    expect(
      resolveExecEnv(GATE_AGENTS, {}, { agentId: "group-agent", sessionKey: GROUP_KEY }),
    ).toEqual({
      GATE_GROUP: "120363000000000000@g.us",
      GATE_AGENT: "group-agent",
      GATE_SESSION: GROUP_KEY,
    });
  });

  it("blanks every GATE value for non-gate agents", () => {
    const empty = { GATE_SENDER: "", GATE_GROUP: "", GATE_AGENT: "", GATE_SESSION: "" };
    expect(
      resolveExecEnv(GATE_AGENTS, { sessionKey: "agent:main:main" }, { agentId: "main" }),
    ).toEqual(empty);
    expect(
      resolveExecEnv(new Set(), {}, { agentId: "group-agent", sessionKey: GROUP_KEY }),
    ).toEqual(empty);
  });
});

describe("session-scope registration", () => {
  it("registers both hooks with the LAST priority and the configured agents", async () => {
    const on = vi.fn();
    plugin.register({
      on,
      logger: { info: vi.fn() },
      pluginConfig: { gateAgents: ["group-agent"] },
    } as unknown as OpenClawPluginApi);

    expect(on.mock.calls.map(([name, , options]) => [name, options])).toEqual([
      ["before_tool_call", { priority: LAST }],
      ["resolve_exec_env", { priority: LAST }],
    ]);
    expect(LAST).toBe(-1000);
    const beforeCall = on.mock.calls[0];
    if (!beforeCall) {
      throw new Error("before_tool_call was not registered");
    }
    const [, beforeHandler] = beforeCall;
    const result = await beforeHandler(
      { toolName: "exec", params: {} },
      { agentId: "group-agent", sessionKey: GROUP_KEY, requester: { senderId: SENDER } },
    );
    expect(result?.params.env.GATE_SENDER).toBe(SENDER);
  });
});

// gate.sh trusts only GATE_SENDER, GATE_GROUP, GATE_AGENT and GATE_SESSION from
// its environment. The model-supplied params.env is replaced, not merged, so the
// model cannot choose an identity. The sender is ctx.requester.senderId of the
// current call with no cached fallback: a cache gave the wrong sender in busy groups.
// Rewriting the command text is not used: absolute paths, `cd . &&` prefixes
// and chained calls bypassed it.

export type GateEnv = {
  GATE_SENDER: string;
  GATE_GROUP: string;
  GATE_AGENT: string;
  GATE_SESSION: string;
};

export type ToolCallEvent = { toolName?: string; params?: Record<string, unknown> };
export type ToolCallContext = {
  agentId?: string;
  sessionKey?: string;
  requester?: { readonly senderId?: string };
};
export type ExecEnvEvent = { sessionKey?: string };
export type ExecEnvContext = { agentId?: string; sessionKey?: string };

const EXEC_TOOLS = new Set(["exec", "bash"]);
const E164 = /^\+[1-9]\d{6,14}$/;
// The last handler's params and env win, so these handlers run after all others.
export const LAST = -1000;

function sessionKeyParts(sessionKey: unknown): { agent: string; peer: string } {
  const parts = typeof sessionKey === "string" ? sessionKey.split(":") : [];
  if (parts.length < 3 || parts[0] !== "agent") {
    return { agent: "", peer: "" };
  }
  return { agent: parts[1] || "", peer: parts.slice(4).join(":") };
}

function resolveAgent(ctxAgentId: unknown, sessionKey: string): string {
  const fromKey = sessionKeyParts(sessionKey).agent;
  if (typeof ctxAgentId === "string" && ctxAgentId) {
    return fromKey && fromKey !== ctxAgentId ? "" : ctxAgentId;
  }
  return fromKey;
}

export function trustedSender(senderId: unknown): string {
  const sender = typeof senderId === "string" ? senderId.trim() : "";
  return E164.test(sender) ? sender : "";
}

function scopeEnv(agent: string, sessionKey: unknown): Omit<GateEnv, "GATE_SENDER"> {
  const key = typeof sessionKey === "string" ? sessionKey : "";
  return {
    GATE_GROUP: sessionKeyParts(key).peer,
    GATE_AGENT: agent,
    GATE_SESSION: key,
  };
}

const EMPTY_GATE_ENV: GateEnv = {
  GATE_SENDER: "",
  GATE_GROUP: "",
  GATE_AGENT: "",
  GATE_SESSION: "",
};

export function beforeToolCall(
  gateAgents: ReadonlySet<string>,
  event: ToolCallEvent | undefined,
  ctx: ToolCallContext | undefined,
): { params: Record<string, unknown> & { env: GateEnv } } | undefined {
  if (!event?.toolName || !EXEC_TOOLS.has(event.toolName)) {
    return undefined;
  }
  const sessionKey = ctx?.sessionKey ?? "";
  const agent = resolveAgent(ctx?.agentId, sessionKey);
  if (!gateAgents.has(agent)) {
    return undefined;
  }
  const env: GateEnv = {
    GATE_SENDER: trustedSender(ctx?.requester?.senderId),
    ...scopeEnv(agent, sessionKey),
  };
  return { params: { ...event.params, env } };
}

// resolve_exec_env runs before before_tool_call and its result is merged over
// params.env. For gate agents it therefore leaves GATE_SENDER out: a value
// here would override the sender that before_tool_call sets for this call.
// Every other agent gets empty GATE_* values, so no model-supplied env can
// give gate an identity from those agents.
export function resolveExecEnv(
  gateAgents: ReadonlySet<string>,
  event: ExecEnvEvent | undefined,
  ctx: ExecEnvContext | undefined,
): Record<string, string> {
  const sessionKey = ctx?.sessionKey ?? event?.sessionKey ?? "";
  const agent = resolveAgent(ctx?.agentId, sessionKey);
  if (!gateAgents.has(agent)) {
    return { ...EMPTY_GATE_ENV };
  }
  return scopeEnv(agent, sessionKey);
}

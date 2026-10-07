export type SessionScopeConfig = {
  gateAgents: ReadonlySet<string>;
};

export function parseSessionScopeConfig(raw: unknown): SessionScopeConfig {
  const gateAgents =
    raw && typeof raw === "object" && Array.isArray((raw as { gateAgents?: unknown }).gateAgents)
      ? (raw as { gateAgents: unknown[] }).gateAgents
      : [];
  return {
    gateAgents: new Set(
      gateAgents.flatMap((agent) =>
        typeof agent === "string" && agent.trim() ? [agent.trim()] : [],
      ),
    ),
  };
}

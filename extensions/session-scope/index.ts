import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseSessionScopeConfig } from "./src/config.js";
import { beforeToolCall, LAST, resolveExecEnv } from "./src/gate-env.js";

export default definePluginEntry({
  id: "session-scope",
  name: "Session Scope",
  description: "Give gate its caller identity from the gateway session",
  register(api) {
    const { gateAgents } = parseSessionScopeConfig(api.pluginConfig);
    api.on(
      "before_tool_call",
      (event, ctx) => {
        const result = beforeToolCall(gateAgents, event, ctx);
        if (result) {
          const env = result.params.env;
          api.logger.info(
            `[session-scope] gate env sender=${env.GATE_SENDER || "MISSING"} group=${env.GATE_GROUP || "-"} agent=${env.GATE_AGENT} tool=${event.toolName}`,
          );
        }
        return result;
      },
      { priority: LAST },
    );
    api.on("resolve_exec_env", (event, ctx) => resolveExecEnv(gateAgents, event, ctx), {
      priority: LAST,
    });
  },
});

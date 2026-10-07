import { Type } from "typebox";
import type { WikiGroupMcpConfig } from "./config.js";
import { callMcpTool } from "./mcp-client.js";
import { parseWhatsAppGroupSession } from "./scope.js";
import { getGroupToken } from "./token-store.js";

const WikiMcpToolSchema = Type.Object(
  {
    tool: Type.String({ minLength: 1 }),
    arguments: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);

type WikiToolContext = { sessionKey?: string; messageChannel?: string };
type WikiToolLogger = { warn?: (message: string) => void };
type WikiToolParams = { tool: string; arguments: Record<string, unknown> };

function textResult(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined };
}

function safeError(error: unknown): string {
  const name = (error as Error | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return "Wiki MCP request timed out.";
  }
  return "Wiki MCP request failed. Ask the owner to check the endpoint and token configuration.";
}

export function createWikiTool(
  context: WikiToolContext,
  config: WikiGroupMcpConfig,
  logger: WikiToolLogger,
) {
  const scope = parseWhatsAppGroupSession(context.sessionKey);
  if (!scope || context.messageChannel !== "whatsapp") {
    return null;
  }
  const allowed = config.allowedTools.join(", ");

  return {
    label: "Group Wiki MCP",
    name: "wiki_mcp",
    description: `Call an approved tool on the Wiki MCP server for this WhatsApp group. Allowed tools: ${allowed || "none configured"}. Group identity and credentials are supplied by the trusted runtime and must never be requested from the user.`,
    parameters: WikiMcpToolSchema,
    execute: async (_toolCallId: string, params: WikiToolParams) => {
      if (!config.url) {
        return textResult("Wiki MCP is not configured: endpoint URL is missing.");
      }
      if (!config.allowedTools.includes(params.tool)) {
        return textResult(`Wiki MCP tool is not allowed. Allowed tools: ${allowed || "none"}.`);
      }

      const token = await getGroupToken(config.credentialFile, scope.groupJid);
      if (!token) {
        return textResult(
          "Wiki MCP is not provisioned for this WhatsApp group. The owner can configure it with /wiki <token>.",
        );
      }

      try {
        const result = await callMcpTool({
          url: config.url,
          authHeader: config.authHeader,
          authScheme: config.authScheme,
          token,
          name: params.tool,
          args: params.arguments,
          timeoutMs: config.timeoutMs,
        });
        const serialized = JSON.stringify(result);
        if (serialized.length > config.maxResponseChars) {
          return textResult(
            `Wiki MCP response exceeded the ${config.maxResponseChars}-character safety limit.`,
          );
        }
        return textResult(serialized);
      } catch (error) {
        logger.warn?.(
          `[wiki-group-mcp] MCP call failed for tool ${params.tool}: ${(error as Error | undefined)?.name || "Error"}`,
        );
        return textResult(safeError(error));
      }
    },
  };
}

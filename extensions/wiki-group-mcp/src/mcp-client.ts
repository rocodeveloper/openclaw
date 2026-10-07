import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpToolCall = {
  url: string;
  authHeader: string;
  authScheme: string;
  token: string;
  name: string;
  args: Record<string, unknown>;
  timeoutMs: number;
};

export async function callMcpTool({
  url,
  authHeader,
  authScheme,
  token,
  name,
  args,
  timeoutMs,
}: McpToolCall) {
  const value = authScheme ? `${authScheme} ${token}` : token;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { [authHeader]: value },
      signal: timeoutSignal,
    },
  });
  const client = new Client({ name: "openclaw-wiki-group-mcp", version: "1.0.0" });

  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args }, undefined, {
      signal: timeoutSignal,
      timeout: timeoutMs,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

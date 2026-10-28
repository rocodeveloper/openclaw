import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { normalizeConfig } from "./config.js";
import { setGroupToken } from "./token-store.js";
import { createWikiTool } from "./wiki-tool.js";

it("executes Wiki tools with group credentials and refuses unauthorized or oversized results", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-execute-"));
  const calls: Array<{ authorization: string | undefined; name: string; arguments: unknown }> = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string; name?: string; arguments?: { query?: string } };
    };
    if (input.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    if (input.method === "tools/call") {
      calls.push({
        authorization: request.headers.authorization,
        name: input.params?.name ?? "",
        arguments: input.params?.arguments,
      });
      if (input.params?.arguments?.query === "failure") {
        response.writeHead(500).end("fixture-a-credential fixture-b-credential");
        return;
      }
    }
    const result =
      input.method === "initialize"
        ? {
            protocolVersion: input.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : {
            content: [
              {
                type: "text",
                text: input.params?.arguments?.query === "large" ? "x".repeat(512) : "group answer",
              },
            ],
          };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture address unavailable");
    }
    const credentialFile = path.join(directory, "credentials.json");
    const groupA = "120363000000000001@g.us";
    const groupB = "120363000000000002@g.us";
    await setGroupToken(credentialFile, groupA, "fixture-a-credential");
    await setGroupToken(credentialFile, groupB, "fixture-b-credential");
    const config = normalizeConfig({
      url: `http://127.0.0.1:${address.port}/mcp`,
      credentialFile,
      allowedTools: ["search"],
      maxResponseChars: 256,
      timeoutMs: 2000,
    });
    const warn = vi.fn();
    const toolFor = (group: string) => {
      const tool = createWikiTool(
        { sessionKey: `agent:main:whatsapp:group:${group}`, messageChannel: "whatsapp" },
        config,
        { warn },
      );
      if (!tool) {
        throw new Error("fixture tool unavailable");
      }
      return tool;
    };
    const first = toolFor(groupA);
    const second = toolFor(groupB);
    for (const [tool, query] of [
      [first, "alpha"],
      [second, "beta"],
    ] as const) {
      const result = await tool.execute("call", { tool: "search", arguments: { query } });
      expect(JSON.parse(expectDefined(result.content[0], "Wiki response").text)).toMatchObject({
        content: [{ type: "text", text: "group answer" }],
      });
    }
    expect(calls).toEqual([
      {
        authorization: "Bearer fixture-a-credential",
        name: "search",
        arguments: { query: "alpha" },
      },
      {
        authorization: "Bearer fixture-b-credential",
        name: "search",
        arguments: { query: "beta" },
      },
    ]);
    const beforeRefusal = requests;
    expect((await first.execute("denied", { tool: "delete", arguments: {} })).content).toEqual([
      { type: "text", text: "Wiki MCP tool is not allowed. Allowed tools: search." },
    ]);
    expect(
      (
        await toolFor("120363000000000003@g.us").execute("missing", {
          tool: "search",
          arguments: {},
        })
      ).content,
    ).toEqual([{ type: "text", text: expect.stringContaining("not provisioned") }]);
    expect(requests).toBe(beforeRefusal);
    expect(
      (await first.execute("large", { tool: "search", arguments: { query: "large" } })).content,
    ).toEqual([
      { type: "text", text: "Wiki MCP response exceeded the 256-character safety limit." },
    ]);
    const failed = await second.execute("failure", {
      tool: "search",
      arguments: { query: "failure" },
    });
    expect(failed.content).toEqual([
      {
        type: "text",
        text: "Wiki MCP request failed. Ask the owner to check the endpoint and token configuration.",
      },
    ]);
    expect(JSON.stringify([failed, warn.mock.calls])).not.toContain("fixture-a-credential");
    expect(JSON.stringify([failed, warn.mock.calls])).not.toContain("fixture-b-credential");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(directory, { recursive: true, force: true });
  }
});

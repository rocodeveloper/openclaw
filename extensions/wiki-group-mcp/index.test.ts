import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { normalizeConfig, resolveDefaultCredentialFile } from "./src/config.js";
import { getGroupToken } from "./src/token-store.js";
import { createWikiTool } from "./src/wiki-tool.js";

const GROUP_SESSION_KEY = "agent:whatsapp-group:whatsapp:group:120363000000000000@g.us";

function registerWikiCommand(pluginConfig: Record<string, unknown>) {
  let command: OpenClawPluginCommandDefinition | undefined;
  plugin.register({
    pluginConfig,
    logger: {},
    registerCommand(value: OpenClawPluginCommandDefinition) {
      command = value;
    },
    registerTool() {},
  } as unknown as OpenClawPluginApi);
  if (!command) {
    throw new Error("expected the wiki command to register");
  }
  return command;
}

describe("wiki-group-mcp plugin", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("keeps /wiki owner-only and group-only and never echoes the token", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-command-"));
    const credentialFile = path.join(directory, "tokens.json");
    const command = registerWikiCommand({ credentialFile });
    expect(command.requiredScopes).toEqual(["operator.admin"]);

    const base = { channel: "whatsapp", channelId: "whatsapp", sessionKey: GROUP_SESSION_KEY };
    const run = (ctx: Record<string, unknown>) =>
      command.handler({ ...base, ...ctx } as Parameters<typeof command.handler>[0]);

    expect((await run({ senderIsOwner: false, args: "secret" })).text).toMatch(/Only/);
    expect(
      (
        await run({
          senderIsOwner: true,
          sessionKey: "agent:main:whatsapp:direct:1@s.whatsapp.net",
          args: "secret",
        })
      ).text,
    ).toMatch(/only be used inside/);

    const response = await run({ senderIsOwner: true, args: "blabla_token" });
    expect(response.text).not.toMatch(/blabla_token/);
    expect(await getGroupToken(credentialFile, "120363000000000000@g.us")).toBe("blabla_token");
  });

  it("omits the wiki tool outside a trusted WhatsApp group context", () => {
    const config = normalizeConfig({});
    expect(
      createWikiTool(
        { messageChannel: "discord", sessionKey: "agent:a:whatsapp:group:1@g.us" },
        config,
        {},
      ),
    ).toBeNull();
    expect(
      createWikiTool(
        { messageChannel: "whatsapp", sessionKey: "agent:a:whatsapp:direct:1@s.whatsapp.net" },
        config,
        {},
      ),
    ).toBeNull();
  });

  it("keeps the default token store in the OpenClaw state directory", () => {
    const stateDir = path.join(os.tmpdir(), "wiki-state");
    expect(resolveDefaultCredentialFile({ OPENCLAW_STATE_DIR: stateDir })).toBe(
      path.join(stateDir, "credentials", "wiki-mcp-tokens.json"),
    );
  });
});

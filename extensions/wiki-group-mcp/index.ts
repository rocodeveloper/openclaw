import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeConfig } from "./src/config.js";
import { resolveCommandGroup } from "./src/scope.js";
import { deleteGroupToken, hasGroupToken, setGroupToken } from "./src/token-store.js";
import { createWikiTool } from "./src/wiki-tool.js";

const MAX_TOKEN_LENGTH = 16384;

export default definePluginEntry({
  id: "wiki-group-mcp",
  name: "Wiki Group MCP",
  description: "Group-scoped Wiki MCP access with owner-provisioned credentials",
  register(api) {
    const config = normalizeConfig(api.pluginConfig);

    api.registerCommand({
      name: "wiki",
      description: "Provision Wiki MCP access for this WhatsApp group.",
      channels: ["whatsapp"],
      acceptsArgs: true,
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        if (ctx.senderIsOwner !== true) {
          return { text: "⛔ Only the OpenClaw owner can use /wiki." };
        }
        const scope = resolveCommandGroup(ctx);
        if (!scope) {
          return { text: "⛔ /wiki can only be used inside a WhatsApp group." };
        }

        const argument = ctx.args?.trim() ?? "";
        if (!argument || argument === "help") {
          return { text: "Usage: /wiki <token> | /wiki status | /wiki unset" };
        }
        if (argument === "status") {
          const configured = await hasGroupToken(config.credentialFile, scope.groupJid);
          return {
            text: configured
              ? "✅ Wiki MCP is provisioned for this group."
              : "Wiki MCP is not provisioned for this group.",
          };
        }
        if (argument === "unset") {
          const removed = await deleteGroupToken(config.credentialFile, scope.groupJid);
          return {
            text: removed
              ? "✅ Wiki MCP credential removed for this group."
              : "Wiki MCP was not provisioned for this group.",
          };
        }
        if (/\s/.test(argument) || argument.length > MAX_TOKEN_LENGTH) {
          return { text: "⛔ Invalid token. Tokens must be a single value no longer than 16 KiB." };
        }

        await setGroupToken(config.credentialFile, scope.groupJid, argument);
        return {
          text: "✅ Wiki MCP credential saved for this group. Delete your token message from WhatsApp history now.",
        };
      },
    });

    api.registerTool((context) => createWikiTool(context, config, api.logger), {
      name: "wiki_mcp",
      optional: true,
    });
  },
});

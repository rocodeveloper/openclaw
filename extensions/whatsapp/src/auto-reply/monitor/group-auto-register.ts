/**
 * Auto-register WhatsApp groups when the owner mentions the bot with "register".
 * Reply "unregistered" when the owner messages in an unknown group without "register".
 * Only triggers for messages that failed group-gating (unregistered groups).
 */

import type { loadConfig } from "../../../../../src/config/config.js";
import { writeConfigFile } from "../../../../../src/config/io.js";
import { normalizeE164 } from "../../../../../src/utils.js";
import type { MentionConfig } from "../mentions.js";
import { resolveOwnerList } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";

function isOwner(baseMentionConfig: MentionConfig, msg: WebInboundMsg): boolean {
  const sender = normalizeE164(msg.senderE164 ?? "");
  if (!sender) return false;
  const owners = resolveOwnerList(baseMentionConfig, msg.selfE164 ?? undefined);
  return owners.includes(sender);
}

export async function handleUnregisteredGroup(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  baseMentionConfig: MentionConfig;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { cfg, msg, conversationId } = params;

  // Only handle owner messages
  if (!isOwner(params.baseMentionConfig, msg)) {
    return;
  }

  const bodyLower = (msg.body ?? "").toLowerCase().trim();
  const isRegisterCommand = /\bregister\b/i.test(bodyLower);

  if (isRegisterCommand) {
    try {
      // Deep-clone config to avoid mutating the cached version
      const newCfg = JSON.parse(JSON.stringify(cfg));

      // Add group to channels.whatsapp.groups
      if (!newCfg.channels) newCfg.channels = {};
      if (!newCfg.channels.whatsapp) newCfg.channels.whatsapp = {};
      if (!newCfg.channels.whatsapp.groups) newCfg.channels.whatsapp.groups = {};
      newCfg.channels.whatsapp.groups[conversationId] = { requireMention: true };

      // Add binding for whatsapp-group agent (before catch-all)
      if (!newCfg.bindings) newCfg.bindings = [];
      const hasBinding = newCfg.bindings.some(
        (b: any) =>
          b.match?.channel === "whatsapp" &&
          b.match?.peer?.kind === "group" &&
          b.match?.peer?.id === conversationId,
      );
      if (!hasBinding) {
        const catchAllIdx = newCfg.bindings.findIndex(
          (b: any) => b.match?.channel === "whatsapp" && !b.match?.peer,
        );
        const newBinding = {
          agentId: "whatsapp-group",
          match: {
            channel: "whatsapp",
            peer: { kind: "group", id: conversationId },
          },
        };
        if (catchAllIdx >= 0) {
          newCfg.bindings.splice(catchAllIdx, 0, newBinding);
        } else {
          newCfg.bindings.push(newBinding);
        }
      }

      await writeConfigFile(newCfg);

      params.logVerbose(`[group-auto-register] Owner registered group ${conversationId}`);

      await msg.reply("Group registered. You can now mention me to chat.");
    } catch (err) {
      params.logVerbose(`[group-auto-register] Failed to register group: ${String(err)}`);
      await msg.reply("Failed to register group.");
    }
    return;
  }

  // Owner messaged but didn't say "register"
  try {
    await msg.reply("Unregistered group. Mention me with 'register' to enable.");
  } catch {
    // Best effort
  }
  params.logVerbose(
    `[group-auto-register] Owner in unregistered group ${conversationId}, sent notice`,
  );
}

/**
 * Auto-register/unregister WhatsApp groups.
 * - /register: owner sends in unregistered group → adds to config
 * - /unregister: owner sends in registered group → removes from config
 * - Unregistered group notice: owner messages without /register → sends hint
 */

import type { loadConfig } from "../../../../../src/config/config.js";
import { writeConfigFile } from "../../../../../src/config/io.js";
import { normalizeE164 } from "../../../../../src/utils.js";
import type { WebInboundMsg } from "../types.js";

function isOwnerSender(
  cfg: ReturnType<typeof loadConfig>,
  msg: WebInboundMsg,
): boolean {
  const sender = normalizeE164(msg.senderE164 ?? "");
  if (!sender) return false;
  const elevatedList =
    (cfg as any).tools?.elevated?.allowFrom?.whatsapp ?? [];
  return elevatedList.some(
    (p: string) => normalizeE164(p) === sender,
  );
}

/**
 * Called when group-gating blocks a message (unregistered group).
 * Handles /register and sends "unregistered" notice for owner.
 */
export async function handleUnregisteredGroup(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { cfg, msg, conversationId } = params;

  if (!isOwnerSender(cfg, msg)) {
    return;
  }

  const commandText = (msg.body ?? "")
    .replace(/@\d+/g, "")
    .trim()
    .toLowerCase();
  const isRegisterCommand =
    commandText === "/register" || commandText === "register";

  if (isRegisterCommand) {
    try {
      const newCfg = JSON.parse(JSON.stringify(cfg));

      if (!newCfg.channels) newCfg.channels = {};
      if (!newCfg.channels.whatsapp) newCfg.channels.whatsapp = {};
      if (!newCfg.channels.whatsapp.groups)
        newCfg.channels.whatsapp.groups = {};
      newCfg.channels.whatsapp.groups[conversationId] = {
        requireMention: true,
      };

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
      params.logVerbose(
        `[group-auto-register] Owner registered group ${conversationId}`,
      );
      await msg.reply(
        "Group registered. You can now mention me to chat.",
      );
    } catch (err) {
      params.logVerbose(
        `[group-auto-register] Failed to register group: ${String(err)}`,
      );
      await msg.reply("Failed to register group.");
    }
    return;
  }

  // Owner messaged but didn't say /register
  try {
    await msg.reply(
      "Unregistered group. Mention me with /register to enable.",
    );
  } catch {
    // Best effort
  }
  params.logVerbose(
    `[group-auto-register] Owner in unregistered group ${conversationId}, sent notice`,
  );
}

/**
 * Called from on-message when owner sends /unregister in a registered group.
 */
export async function handleGroupUnregister(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { cfg, msg, conversationId } = params;

  if (!isOwnerSender(cfg, msg)) {
    return;
  }

  try {
    const newCfg = JSON.parse(JSON.stringify(cfg));

    if (newCfg.channels?.whatsapp?.groups?.[conversationId]) {
      delete newCfg.channels.whatsapp.groups[conversationId];
    }

    if (newCfg.bindings) {
      newCfg.bindings = newCfg.bindings.filter(
        (b: any) =>
          !(
            b.match?.channel === "whatsapp" &&
            b.match?.peer?.kind === "group" &&
            b.match?.peer?.id === conversationId
          ),
      );
    }

    await writeConfigFile(newCfg);
    params.logVerbose(
      `[group-auto-register] Owner unregistered group ${conversationId}`,
    );
    await msg.reply("Group unregistered.");
  } catch (err) {
    params.logVerbose(
      `[group-auto-register] Failed to unregister group: ${String(err)}`,
    );
    await msg.reply("Failed to unregister group.");
  }
}

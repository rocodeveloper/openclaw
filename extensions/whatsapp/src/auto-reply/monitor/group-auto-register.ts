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
 * Returns the account-config key matching `accountId` case-insensitively,
 * or undefined if no such account is configured.
 */
function findAccountKey(
  accounts: Record<string, unknown> | undefined,
  accountId: string | undefined,
): string | undefined {
  if (!accounts || !accountId) return undefined;
  if (Object.hasOwn(accounts, accountId)) return accountId;
  const target = accountId.toLowerCase();
  return Object.keys(accounts).find((k) => k.toLowerCase() === target);
}

/**
 * Mirrors the SDK group-policy resolver:
 *   accounts[accountId]?.groups ?? channels.whatsapp.groups
 * Ensures the registered group lands where the gating check will read it.
 * Mutates `cfg` and returns the groups object to write into.
 */
function ensureGroupsContainer(
  cfg: any,
  accountId: string | undefined,
): Record<string, unknown> {
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.whatsapp) cfg.channels.whatsapp = {};
  const wa = cfg.channels.whatsapp;
  const accountKey = findAccountKey(wa.accounts, accountId);
  if (accountKey) {
    const account = wa.accounts[accountKey];
    if (!account.groups) account.groups = {};
    return account.groups;
  }
  if (!wa.groups) wa.groups = {};
  return wa.groups;
}

/**
 * Called when group-gating blocks a message (unregistered group).
 * Handles /register and sends "unregistered" notice for owner.
 */
export async function handleUnregisteredGroup(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  accountId?: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { cfg, msg, conversationId, accountId } = params;

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

      const groups = ensureGroupsContainer(newCfg, accountId);
      groups[conversationId] = { requireMention: true };

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
  accountId?: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { cfg, msg, conversationId, accountId } = params;

  if (!isOwnerSender(cfg, msg)) {
    return;
  }

  try {
    const newCfg = JSON.parse(JSON.stringify(cfg));

    // Remove from both potential locations: account-scoped (if any) and
    // top-level channel groups. This covers legacy entries written before
    // the account-aware fix as well as the current account's allowlist.
    const wa = newCfg.channels?.whatsapp;
    if (wa) {
      const accountKey = findAccountKey(wa.accounts, accountId);
      if (accountKey && wa.accounts[accountKey]?.groups?.[conversationId]) {
        delete wa.accounts[accountKey].groups[conversationId];
      }
      if (wa.groups?.[conversationId]) {
        delete wa.groups[conversationId];
      }
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

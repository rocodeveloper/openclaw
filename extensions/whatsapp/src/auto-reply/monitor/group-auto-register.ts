/**
 * Auto-register / unregister WhatsApp groups (fork feature).
 * - /register   : owner sends in an unregistered group -> add it to config
 * - /unregister : owner sends in a registered group   -> remove it from config
 * - otherwise   : owner messaging an unregistered group gets a one-line hint
 *
 * Owner detection mirrors group-gating.ts (resolveOwnerList over the mention
 * config). Group writes are account-scoped: accounts[accountId].groups when the
 * account exists, else the top-level channels.whatsapp.groups — matching the
 * SDK group-policy resolver so the gating check reads them back.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { writeConfigFile } from "../../../../../src/config/io.js";
import { getSelfIdentity, getSenderIdentity } from "../../identity.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { resolveOwnerList } from "../mentions.js";
import { normalizeE164 } from "./group-gating.runtime.js";

function normalizeGroupCommandText(text: string | undefined): string {
  return (text ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\uFEFF]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isRegisterCommand(text: string | undefined): boolean {
  const commandText = normalizeGroupCommandText(text);
  return commandText === "/register" || commandText === "register";
}

export function isUnregisterCommand(text: string | undefined): boolean {
  const commandText = normalizeGroupCommandText(text);
  return commandText === "/unregister" || commandText === "unregister";
}

function isOwnerSender(
  baseMentionConfig: MentionConfig,
  msg: WebInboundMessage,
  authDir?: string,
): boolean {
  const sender = normalizeE164(getSenderIdentity(msg, authDir).e164 ?? "");
  if (!sender) return false;
  const owners = resolveOwnerList(baseMentionConfig, getSelfIdentity(msg, authDir).e164 ?? undefined);
  return owners.includes(sender);
}

/** Account-config key matching `accountId` case-insensitively, or undefined. */
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
 * Resolve (and create) the groups container to write into:
 *   accounts[accountId]?.groups ?? channels.whatsapp.groups
 * Mutates `cfg` and returns the groups object.
 */
function ensureGroupsContainer(
  // deno-lint-ignore no-explicit-any
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
 * Called when group-gating blocks a message because the group is unregistered.
 * Owner-only: handles /register, otherwise sends a one-line hint.
 */
export async function handleUnregisteredGroup(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  conversationId: string;
  accountId?: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { cfg, msg, conversationId, accountId } = params;

  if (!isOwnerSender(params.baseMentionConfig, msg, params.authDir)) {
    return;
  }

  if (isRegisterCommand(msg.payload.body)) {
    try {
      // deno-lint-ignore no-explicit-any
      const newCfg = JSON.parse(JSON.stringify(cfg)) as any;

      const groups = ensureGroupsContainer(newCfg, accountId);
      groups[conversationId] = { requireMention: true };

      if (!newCfg.bindings) newCfg.bindings = [];
      const hasBinding = newCfg.bindings.some(
        // deno-lint-ignore no-explicit-any
        (b: any) =>
          b.match?.channel === "whatsapp" &&
          b.match?.peer?.kind === "group" &&
          b.match?.peer?.id === conversationId,
      );
      if (!hasBinding) {
        const catchAllIdx = newCfg.bindings.findIndex(
          // deno-lint-ignore no-explicit-any
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

  // Owner messaged but didn't say /register
  try {
    await msg.reply("Unregistered group. Mention me with /register to enable.");
  } catch {
    // Best effort
  }
  params.logVerbose(
    `[group-auto-register] Owner in unregistered group ${conversationId}, sent notice`,
  );
}

/** Owner-only /unregister handling for a registered group. */
export async function handleGroupUnregister(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  conversationId: string;
  accountId?: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { cfg, msg, conversationId, accountId } = params;

  if (!isOwnerSender(params.baseMentionConfig, msg, params.authDir)) {
    return;
  }

  try {
    // deno-lint-ignore no-explicit-any
    const newCfg = JSON.parse(JSON.stringify(cfg)) as any;

    // Remove from both account-scoped and top-level locations to cover legacy
    // entries written before the account-aware fix.
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
        // deno-lint-ignore no-explicit-any
        (b: any) =>
          !(
            b.match?.channel === "whatsapp" &&
            b.match?.peer?.kind === "group" &&
            b.match?.peer?.id === conversationId
          ),
      );
    }

    await writeConfigFile(newCfg);
    params.logVerbose(`[group-auto-register] Owner unregistered group ${conversationId}`);
    await msg.reply("Group unregistered.");
  } catch (err) {
    params.logVerbose(`[group-auto-register] Failed to unregister group: ${String(err)}`);
    await msg.reply("Failed to unregister group.");
  }
}

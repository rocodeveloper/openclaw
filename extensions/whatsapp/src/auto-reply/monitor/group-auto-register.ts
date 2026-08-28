import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSelfIdentity, getSenderIdentity } from "../../identity.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { getWhatsAppRuntime } from "../../runtime.js";
import type { MentionConfig } from "../mentions.js";
import { resolveOwnerList } from "../mentions.js";
import { normalizeE164 } from "./group-gating.runtime.js";

type WhatsAppConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>;
type WhatsAppAccounts = NonNullable<WhatsAppConfig["accounts"]>;
type WhatsAppGroups = NonNullable<WhatsAppConfig["groups"]>;

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
  const owners = resolveOwnerList(
    baseMentionConfig,
    getSelfIdentity(msg, authDir).e164 ?? undefined,
  );
  return owners.includes(sender);
}

function findAccountKey(
  accounts: WhatsAppAccounts | undefined,
  accountId: string | undefined,
): string | undefined {
  if (!accounts || !accountId) return undefined;
  if (Object.hasOwn(accounts, accountId)) return accountId;
  const target = accountId.toLowerCase();
  return Object.keys(accounts).find((k) => k.toLowerCase() === target);
}

function ensureGroupsContainer(cfg: OpenClawConfig, accountId: string | undefined): WhatsAppGroups {
  cfg.channels ??= {};
  cfg.channels.whatsapp ??= {};
  const wa = cfg.channels.whatsapp;
  const accountKey = findAccountKey(wa.accounts, accountId);
  const account = accountKey ? wa.accounts?.[accountKey] : undefined;
  if (account) {
    account.groups ??= {};
    return account.groups;
  }
  wa.groups ??= {};
  return wa.groups;
}

export async function handleUnregisteredGroup(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  conversationId: string;
  accountId?: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { msg, conversationId, accountId } = params;

  if (!isOwnerSender(params.baseMentionConfig, msg, params.authDir)) {
    return;
  }

  if (isRegisterCommand(msg.payload.body)) {
    try {
      await getWhatsAppRuntime().config.mutateConfigFile({
        afterWrite: { mode: "auto" },
        mutate: (draft) => {
          const groups = ensureGroupsContainer(draft, accountId);
          groups[conversationId] = { requireMention: true };

          draft.bindings ??= [];
          const hasBinding = draft.bindings.some(
            (binding) =>
              binding.match.channel === "whatsapp" &&
              binding.match.peer?.kind === "group" &&
              binding.match.peer.id === conversationId,
          );
          if (!hasBinding) {
            const catchAllIdx = draft.bindings.findIndex(
              (binding) => binding.match.channel === "whatsapp" && !binding.match.peer,
            );
            const newBinding = {
              agentId: "whatsapp-group",
              match: {
                channel: "whatsapp",
                ...(accountId ? { accountId } : {}),
                peer: { kind: "group", id: conversationId },
              },
            } satisfies NonNullable<OpenClawConfig["bindings"]>[number];
            if (catchAllIdx >= 0) {
              draft.bindings.splice(catchAllIdx, 0, newBinding);
            } else {
              draft.bindings.push(newBinding);
            }
          }
        },
      });
      params.logVerbose(`[group-auto-register] Owner registered group ${conversationId}`);
      await msg.reply("Group registered. You can now mention me to chat.");
    } catch (err) {
      params.logVerbose(`[group-auto-register] Failed to register group: ${String(err)}`);
      await msg.reply("Failed to register group.");
    }
    return;
  }

  try {
    await msg.reply("Unregistered group. Mention me with /register to enable.");
  } catch {
    // The notice must not block message handling when WhatsApp rejects the reply.
  }
  params.logVerbose(
    `[group-auto-register] Owner in unregistered group ${conversationId}, sent notice`,
  );
}

export async function handleGroupUnregister(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  conversationId: string;
  accountId?: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { msg, conversationId, accountId } = params;

  if (!isOwnerSender(params.baseMentionConfig, msg, params.authDir)) {
    return;
  }

  try {
    await getWhatsAppRuntime().config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        // Remove both entries because older versions wrote groups without an account scope.
        const wa = draft.channels?.whatsapp;
        if (wa) {
          const accountKey = findAccountKey(wa.accounts, accountId);
          if (accountKey && wa.accounts[accountKey]?.groups?.[conversationId]) {
            delete wa.accounts[accountKey].groups[conversationId];
          }
          if (wa.groups?.[conversationId]) {
            delete wa.groups[conversationId];
          }
        }

        if (draft.bindings) {
          draft.bindings = draft.bindings.filter(
            (binding) =>
              !(
                binding.match.channel === "whatsapp" &&
                binding.match.peer?.kind === "group" &&
                binding.match.peer.id === conversationId
              ),
          );
        }
      },
    });
    params.logVerbose(`[group-auto-register] Owner unregistered group ${conversationId}`);
    await msg.reply("Group unregistered.");
  } catch (err) {
    params.logVerbose(`[group-auto-register] Failed to unregister group: ${String(err)}`);
    await msg.reply("Failed to unregister group.");
  }
}

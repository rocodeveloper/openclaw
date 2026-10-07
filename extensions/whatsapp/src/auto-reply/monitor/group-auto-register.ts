import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId, normalizeOptionalAccountId } from "openclaw/plugin-sdk/routing";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { getWhatsAppRuntime } from "../../runtime.js";

type WhatsAppConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>;
type WhatsAppAccounts = NonNullable<WhatsAppConfig["accounts"]>;
type WhatsAppGroups = NonNullable<WhatsAppConfig["groups"]>;
type RouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];

function normalizeGroupCommandText(text: string | undefined): string {
  return (text ?? "")
    .normalize("NFKC")
    .replace(/[​-‏﻿]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isRegisterCommand(text: string | undefined): boolean {
  const commandText = normalizeGroupCommandText(text);
  return commandText === "/register" || commandText === "register";
}

export function isUnregisterCommand(text: string | undefined): boolean {
  const commandText = normalizeGroupCommandText(text);
  return commandText === "/unregister" || commandText === "unregister";
}

function findAccountKey(
  accounts: WhatsAppAccounts | undefined,
  accountId: string | undefined,
): string | undefined {
  if (!accounts || !accountId) {
    return undefined;
  }
  if (Object.hasOwn(accounts, accountId)) {
    return accountId;
  }
  const target = accountId.toLowerCase();
  return Object.keys(accounts).find((key) => key.toLowerCase() === target);
}

function matchesGroupBinding(
  binding: RouteBinding,
  conversationId: string,
  accountId: string | undefined,
): boolean {
  if (
    binding.match.channel !== "whatsapp" ||
    binding.match.peer?.kind !== "group" ||
    binding.match.peer.id !== conversationId
  ) {
    return false;
  }
  const expectedAccountId = normalizeAccountId(accountId);
  const bindingAccountId = normalizeOptionalAccountId(binding.match.accountId);
  return (
    bindingAccountId === expectedAccountId ||
    (expectedAccountId === "default" && bindingAccountId === undefined)
  );
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

function registerGroup(
  draft: OpenClawConfig,
  params: { conversationId: string; accountId?: string; agentId: string },
) {
  const { conversationId, accountId, agentId } = params;
  ensureGroupsContainer(draft, accountId)[conversationId] = { requireMention: true };
  draft.bindings ??= [];
  if (draft.bindings.some((binding) => matchesGroupBinding(binding, conversationId, accountId))) {
    return;
  }
  const newBinding = {
    agentId,
    match: {
      channel: "whatsapp",
      ...(accountId ? { accountId } : {}),
      peer: { kind: "group", id: conversationId },
    },
  } satisfies RouteBinding;
  const catchAllIndex = draft.bindings.findIndex(
    (binding) => binding.match.channel === "whatsapp" && !binding.match.peer,
  );
  if (catchAllIndex >= 0) {
    draft.bindings.splice(catchAllIndex, 0, newBinding);
  } else {
    draft.bindings.push(newBinding);
  }
}

function unregisterGroup(
  draft: OpenClawConfig,
  params: { conversationId: string; accountId?: string },
) {
  const { conversationId, accountId } = params;
  const wa = draft.channels?.whatsapp;
  if (wa) {
    const accountKey = findAccountKey(wa.accounts, accountId);
    if (accountKey) {
      delete wa.accounts?.[accountKey]?.groups?.[conversationId];
    } else if (wa.groups?.[conversationId]) {
      delete wa.groups[conversationId];
    }
  }
  if (draft.bindings) {
    draft.bindings = draft.bindings.filter(
      (binding) => !matchesGroupBinding(binding, conversationId, accountId),
    );
  }
}

export async function handleOwnerInUnregisteredGroup(params: {
  msg: AdmittedWebInboundMessage;
  conversationId: string;
  accountId?: string;
  agentId: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { msg, conversationId } = params;
  if (!isRegisterCommand(msg.payload.body)) {
    await msg.platform
      .reply("Unregistered group. Mention me with /register to enable.")
      .catch(() => undefined);
    params.logVerbose(
      `[group-auto-register] Owner in unregistered group ${conversationId}, sent notice`,
    );
    return;
  }
  try {
    await getWhatsAppRuntime().config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => registerGroup(draft, params),
    });
    params.logVerbose(`[group-auto-register] Owner registered group ${conversationId}`);
    await msg.platform.reply("Group registered. You can now mention me to chat.");
  } catch (err) {
    params.logVerbose(`[group-auto-register] Failed to register group: ${String(err)}`);
    await msg.platform.reply("Failed to register group.");
  }
}

export async function handleOwnerGroupUnregister(params: {
  msg: AdmittedWebInboundMessage;
  conversationId: string;
  accountId?: string;
  logVerbose: (msg: string) => void;
}): Promise<void> {
  const { msg, conversationId } = params;
  try {
    await getWhatsAppRuntime().config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => unregisterGroup(draft, params),
    });
    params.logVerbose(`[group-auto-register] Owner unregistered group ${conversationId}`);
    await msg.platform.reply("Group unregistered.");
  } catch (err) {
    params.logVerbose(`[group-auto-register] Failed to unregister group: ${String(err)}`);
    await msg.platform.reply("Failed to unregister group.");
  }
}

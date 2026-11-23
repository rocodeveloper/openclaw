import { DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS as LONGEST_DURABLE_REPLAY_DELAY_MS } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMergedWhatsAppAccountConfig } from "../account-config.js";

const pauseEndsAtByChat = new Map<string, number>();
const ownSendExpiresAtByMessage = new Map<string, number>();

function buildChatKey(params: { accountId: string; chat: string }): string {
  return `${params.accountId}:${params.chat}`;
}

export function resolveStaffPauseMinutes(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): number {
  const minutes = resolveMergedWhatsAppAccountConfig(params).staffPause?.minutes;
  return typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? minutes : 0;
}

export function resolveStaffPauseEnd(params: {
  pauseMinutes: number;
  sentAtMs?: number;
  now?: number;
}): number | undefined {
  if (params.pauseMinutes <= 0) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const startedAt = Math.min(now, params.sentAtMs ?? now);
  const pauseEndsAt = startedAt + params.pauseMinutes * 60_000;
  return pauseEndsAt > now ? pauseEndsAt : undefined;
}

export function recordStaffMessage(params: {
  accountId: string;
  chat: string;
  pauseMinutes: number;
  sentAtMs?: number;
  now?: number;
}): number | undefined {
  const pauseEndsAt = resolveStaffPauseEnd(params);
  if (pauseEndsAt === undefined) {
    return undefined;
  }
  return recordStaffPauseEnd({ ...params, pauseEndsAt });
}

export function recordStaffPauseEnd(params: {
  accountId: string;
  chat: string;
  pauseEndsAt: number;
  now?: number;
}): number {
  const now = params.now ?? Date.now();
  for (const [key, pauseEndsAt] of pauseEndsAtByChat) {
    if (pauseEndsAt + LONGEST_DURABLE_REPLAY_DELAY_MS <= now) {
      pauseEndsAtByChat.delete(key);
    }
  }
  const key = buildChatKey(params);
  const extendedPauseEndsAt = Math.max(pauseEndsAtByChat.get(key) ?? 0, params.pauseEndsAt);
  pauseEndsAtByChat.set(key, extendedPauseEndsAt);
  return extendedPauseEndsAt;
}

export function getActiveStaffPauseEnd(params: {
  accountId: string;
  chat: string;
  receivedAtMs: number;
}): number | undefined {
  const pauseEndsAt = pauseEndsAtByChat.get(buildChatKey(params));
  return pauseEndsAt !== undefined && params.receivedAtMs < pauseEndsAt ? pauseEndsAt : undefined;
}

function buildMessageKey(params: { accountId: string; chat: string; messageId: string }): string {
  return `${params.accountId}:${params.chat}:${params.messageId}`;
}

export function rememberOwnSend(params: {
  accountId: string;
  chat: string;
  messageId: string;
  pauseMinutes: number;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  for (const [key, expiresAt] of ownSendExpiresAtByMessage) {
    if (expiresAt <= now) {
      ownSendExpiresAtByMessage.delete(key);
    }
  }
  ownSendExpiresAtByMessage.set(buildMessageKey(params), now + params.pauseMinutes * 60_000);
}

export function isRememberedOwnSend(params: {
  accountId: string;
  chat: string;
  messageId: string;
  now?: number;
}): boolean {
  const expiresAt = ownSendExpiresAtByMessage.get(buildMessageKey(params));
  return expiresAt !== undefined && expiresAt > (params.now ?? Date.now());
}

export function describeStaffPause(params: {
  pauseMinutes: number;
  pauseEndsAt: number | undefined;
}): string {
  if (params.pauseMinutes <= 0) {
    return "pause=off";
  }
  if (params.pauseEndsAt === undefined) {
    return `pause=${params.pauseMinutes} not started, message is older than the pause`;
  }
  return `pause=${params.pauseMinutes} pause until ${new Date(params.pauseEndsAt).toISOString()}`;
}

export function maskChatForLog(chat: string): string {
  return `***${chat.replace(/\D/g, "").slice(-3)}`;
}

export function resetStaffPauses(): void {
  pauseEndsAtByChat.clear();
  ownSendExpiresAtByMessage.clear();
}

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

function resolveNewPauseEnd(params: {
  pauseMinutes: number;
  sentAtMs?: number;
  now: number;
}): number | undefined {
  if (params.pauseMinutes <= 0) {
    return undefined;
  }
  const startedAt = Math.min(params.now, params.sentAtMs ?? params.now);
  const pauseEndsAt = startedAt + params.pauseMinutes * 60_000;
  return pauseEndsAt > params.now ? pauseEndsAt : undefined;
}

export function wouldStartStaffPause(params: {
  pauseMinutes: number;
  sentAtMs?: number;
  now?: number;
}): boolean {
  return resolveNewPauseEnd({ ...params, now: params.now ?? Date.now() }) !== undefined;
}

export function recordStaffMessage(params: {
  accountId: string;
  chat: string;
  pauseMinutes: number;
  sentAtMs?: number;
  now?: number;
}): number | undefined {
  const now = params.now ?? Date.now();
  const pauseEndsAt = resolveNewPauseEnd({ ...params, now });
  if (pauseEndsAt === undefined) {
    return undefined;
  }
  const key = buildChatKey(params);
  const extendedPauseEndsAt = Math.max(pauseEndsAtByChat.get(key) ?? 0, pauseEndsAt);
  pauseEndsAtByChat.set(key, extendedPauseEndsAt);
  return extendedPauseEndsAt;
}

export function getActiveStaffPauseEnd(params: {
  accountId: string;
  chat: string;
  now?: number;
}): number | undefined {
  const now = params.now ?? Date.now();
  const key = buildChatKey(params);
  const pauseEndsAt = pauseEndsAtByChat.get(key);
  if (pauseEndsAt === undefined) {
    return undefined;
  }
  if (pauseEndsAt <= now) {
    pauseEndsAtByChat.delete(key);
    return undefined;
  }
  return pauseEndsAt;
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

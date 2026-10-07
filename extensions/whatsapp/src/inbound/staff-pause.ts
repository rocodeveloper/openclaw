import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMergedWhatsAppAccountConfig } from "../account-config.js";

const pauseEndsAtByChat = new Map<string, number>();

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

export function recordStaffMessage(params: {
  accountId: string;
  chat: string;
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
  if (pauseEndsAt <= now) {
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
}

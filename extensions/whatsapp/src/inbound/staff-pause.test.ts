import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../../config-api.js";
import {
  describeStaffPause,
  getActiveStaffPauseEnd,
  maskChatForLog,
  recordStaffMessage,
  resetStaffPauses,
  resolveStaffPauseMinutes,
} from "./staff-pause.js";

const chat = { accountId: "acct-a", chat: "+15550001234" };
const pauseMinutes = 30;
const pauseMs = pauseMinutes * 60_000;
const now = Date.UTC(2026, 9, 5, 12, 0, 0);

function parseConfig(whatsapp: unknown): OpenClawConfig {
  return { channels: { whatsapp: WhatsAppConfigSchema.parse(whatsapp) } } as OpenClawConfig;
}

describe("WhatsApp staff pause config", () => {
  it("is off when the key is absent", () => {
    const cfg = parseConfig({ accounts: { "acct-a": {} } });

    expect(resolveStaffPauseMinutes({ cfg, accountId: "acct-a" })).toBe(0);
  });

  it("is off when the account value is 0", () => {
    const cfg = parseConfig({ accounts: { "acct-a": { staffPause: { minutes: 0 } } } });

    expect(resolveStaffPauseMinutes({ cfg, accountId: "acct-a" })).toBe(0);
  });

  it("uses the account value", () => {
    const cfg = parseConfig({ accounts: { "acct-a": { staffPause: { minutes: 45 } } } });

    expect(resolveStaffPauseMinutes({ cfg, accountId: "acct-a" })).toBe(45);
  });

  it("inherits the channel default", () => {
    const cfg = parseConfig({
      staffPause: { minutes: 20 },
      accounts: { "acct-a": {}, default: {} },
    });

    expect(resolveStaffPauseMinutes({ cfg, accountId: "acct-a" })).toBe(20);
    expect(resolveStaffPauseMinutes({ cfg, accountId: "default" })).toBe(20);
  });

  it("lets an account override the channel default", () => {
    const cfg = parseConfig({
      staffPause: { minutes: 20 },
      accounts: { "acct-a": { staffPause: { minutes: 5 } }, quiet: { staffPause: { minutes: 0 } } },
    });

    expect(resolveStaffPauseMinutes({ cfg, accountId: "acct-a" })).toBe(5);
    expect(resolveStaffPauseMinutes({ cfg, accountId: "quiet" })).toBe(0);
  });

  it("is off when no WhatsApp config exists", () => {
    expect(resolveStaffPauseMinutes({ cfg: {} as OpenClawConfig, accountId: "acct-a" })).toBe(0);
  });
});

describe("WhatsApp staff pause", () => {
  beforeEach(() => {
    resetStaffPauses();
  });

  it("pauses the chat for the configured minutes after a staff message", () => {
    const pauseEndsAt = recordStaffMessage({ ...chat, pauseMinutes, now });

    expect(pauseEndsAt).toBe(now + pauseMs);
    expect(getActiveStaffPauseEnd({ ...chat, now: now + 1 })).toBe(pauseEndsAt);
    expect(getActiveStaffPauseEnd({ ...chat, now: now + pauseMs - 1 })).toBe(pauseEndsAt);
  });

  it("uses a different configured value", () => {
    const pauseEndsAt = recordStaffMessage({ ...chat, pauseMinutes: 2, now });

    expect(pauseEndsAt).toBe(now + 2 * 60_000);
    expect(getActiveStaffPauseEnd({ ...chat, now: now + 2 * 60_000 })).toBe(undefined);
  });

  it("does not pause when the configured value is 0", () => {
    const pauseEndsAt = recordStaffMessage({ ...chat, pauseMinutes: 0, now });

    expect(pauseEndsAt).toBe(undefined);
    expect(getActiveStaffPauseEnd({ ...chat, now })).toBe(undefined);
  });

  it("ends the pause when the duration has passed", () => {
    recordStaffMessage({ ...chat, pauseMinutes, now });

    expect(getActiveStaffPauseEnd({ ...chat, now: now + pauseMs })).toBe(undefined);
  });

  it("moves the end forward with each further staff message", () => {
    recordStaffMessage({ ...chat, pauseMinutes, now });
    const later = now + 10 * 60_000;

    const pauseEndsAt = recordStaffMessage({ ...chat, pauseMinutes, now: later });

    expect(pauseEndsAt).toBe(later + pauseMs);
    expect(getActiveStaffPauseEnd({ ...chat, now: now + pauseMs + 1 })).toBe(pauseEndsAt);
  });

  it("keeps other chats and other accounts unpaused", () => {
    recordStaffMessage({ ...chat, pauseMinutes, now });

    expect(getActiveStaffPauseEnd({ ...chat, chat: "+15550009999", now })).toBe(undefined);
    expect(getActiveStaffPauseEnd({ ...chat, accountId: "default", now })).toBe(undefined);
  });

  it("counts the pause from the time the staff message was sent", () => {
    const sentAtMs = now - 10 * 60_000;

    const pauseEndsAt = recordStaffMessage({ ...chat, pauseMinutes, sentAtMs, now });

    expect(pauseEndsAt).toBe(sentAtMs + pauseMs);
  });

  it("ignores a staff message that is older than the pause duration", () => {
    const pauseEndsAt = recordStaffMessage({ ...chat, pauseMinutes, sentAtMs: now - pauseMs, now });

    expect(pauseEndsAt).toBe(undefined);
    expect(getActiveStaffPauseEnd({ ...chat, now })).toBe(undefined);
  });

  it("does not shorten an active pause when an older staff message arrives late", () => {
    const pauseEndsAt = recordStaffMessage({ ...chat, pauseMinutes, now });

    recordStaffMessage({ ...chat, pauseMinutes, sentAtMs: now - 5 * 60_000, now: now + 1 });

    expect(getActiveStaffPauseEnd({ ...chat, now: now + 2 })).toBe(pauseEndsAt);
  });

  it("describes the pause for the log line", () => {
    expect(describeStaffPause({ pauseMinutes: 0, pauseEndsAt: undefined })).toBe("pause=off");
    expect(describeStaffPause({ pauseMinutes: 30, pauseEndsAt: now })).toBe(
      "pause=30 pause until 2026-10-05T12:00:00.000Z",
    );
    expect(describeStaffPause({ pauseMinutes: 30, pauseEndsAt: undefined })).toBe(
      "pause=30 not started, message is older than the pause",
    );
  });

  it("masks a chat to its last three digits", () => {
    expect(maskChatForLog("+15550001234")).toBe("***234");
    expect(maskChatForLog("15550001234@s.whatsapp.net")).toBe("***234");
  });
});

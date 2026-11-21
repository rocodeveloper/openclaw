import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const event = {
  channel: "whatsapp",
  accountId: "rococode",
  conversationId: "+441134960425",
  messageId: "3EB0C431C26A1916E07A",
  timestampMs: 1_763_738_814_000,
};
const ctx = { channelId: "whatsapp", accountId: "rococode", conversationId: "+441134960425" };

describe("staff_message first claim", () => {
  it("lets the first ownSend true decide after declines, errors and timeouts", async () => {
    const later = vi.fn(async () => ({ ownSend: false }));
    const { runner } = createHookRunnerWithRegistry([
      { pluginId: "silent", priority: 50, hookName: "staff_message", handler: async () => {} },
      {
        pluginId: "declines",
        priority: 40,
        hookName: "staff_message",
        handler: async () => ({ ownSend: false }),
      },
      {
        pluginId: "broken",
        priority: 30,
        hookName: "staff_message",
        handler: async () => {
          throw new Error("api-service unreachable");
        },
      },
      {
        pluginId: "stalled",
        priority: 20,
        hookName: "staff_message",
        timeoutMs: 5,
        handler: () => new Promise(() => {}),
      },
      {
        pluginId: "booking-identity",
        priority: 10,
        hookName: "staff_message",
        handler: async () => ({ ownSend: true }),
      },
      { pluginId: "later", priority: 0, hookName: "staff_message", handler: later },
    ]);

    await expect(runner.runStaffMessage(event, ctx)).resolves.toEqual({ ownSend: true });
    expect(later).not.toHaveBeenCalled();
  });

  it("returns no claim when every handler declines, fails or times out", async () => {
    const { runner } = createHookRunnerWithRegistry([
      { pluginId: "silent", hookName: "staff_message", handler: async () => {} },
      {
        pluginId: "declines",
        hookName: "staff_message",
        handler: async () => ({ ownSend: false }),
      },
      {
        pluginId: "broken",
        hookName: "staff_message",
        handler: async () => {
          throw new Error("api-service unreachable");
        },
      },
      {
        pluginId: "stalled",
        hookName: "staff_message",
        timeoutMs: 5,
        handler: () => new Promise(() => {}),
      },
    ]);

    await expect(runner.runStaffMessage(event, ctx)).resolves.toBeUndefined();
  });
});

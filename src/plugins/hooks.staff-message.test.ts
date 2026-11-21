import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const event = {
  channel: "whatsapp",
  accountId: "rococode",
  conversationId: "+441134960425",
};
const ctx = { channelId: "whatsapp", accountId: "rococode", conversationId: "+441134960425" };

describe("staff_message first claim", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("stops waiting for a handler without a timeout after 5 seconds", async () => {
    vi.useFakeTimers();
    const { runner } = createHookRunnerWithRegistry([
      {
        pluginId: "stalled",
        priority: 10,
        hookName: "staff_message",
        handler: () => new Promise(() => {}),
      },
      {
        pluginId: "booking-identity",
        priority: 0,
        hookName: "staff_message",
        handler: async () => ({ ownSend: true }),
      },
    ]);
    let claim: unknown = "pending";
    void runner.runStaffMessage(event, ctx).then((result) => {
      claim = result;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(claim).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toEqual({ ownSend: true });
  });
});

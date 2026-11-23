import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeWhatsAppDurableInboundMessage } from "./inbound/durable-payload.js";
import {
  createWhatsAppDurableInboundMessageId,
  createWhatsAppDurableInboundQueue,
} from "./inbound/durable-receive.js";
import {
  buildNotifyMessageUpsert,
  createAllowListConfig,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MESSAGES_CFG,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  nowSeconds,
  openInboxMonitor,
  waitForInboundWorkDrained,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  it("skips the agent for a direct chat after a staff message from the phone", async () => {
    configureStaffPause(30);

    const senders = await sendFromPhoneThenGuestMessages("staff-1", nowSeconds());

    expect(senders).toEqual(["+888"]);
  });

  it("keeps the agent active after a staff message when the staff pause is not configured", async () => {
    mockLoadConfig.mockReturnValue(createAllowListConfig(["*"]));

    const senders = await sendFromPhoneThenGuestMessages("staff-off-1", nowSeconds());

    expect(senders).toEqual(["+888", "+999"]);
  });
});

function configureStaffPause(minutes: number) {
  mockLoadConfig.mockReturnValue({
    channels: { whatsapp: { allowFrom: ["*"], staffPause: { minutes } } },
    messages: DEFAULT_MESSAGES_CFG,
  });
}

function registerStaffMessageHandler(handler: (...args: unknown[]) => unknown, timeoutMs?: number) {
  const registry = createEmptyPluginRegistry();
  addTestHook({
    registry,
    pluginId: "booking-identity",
    hookName: "staff_message",
    handler: handler as PluginHookRegistration["handler"],
    timeoutMs,
  });
  initializeGlobalHookRunner(registry);
}

type InboxSocket = Awaited<ReturnType<typeof openInboxMonitor>>["sock"];

function emitFromPhone(
  sock: InboxSocket,
  fromMeId: string,
  fromMeTimestamp: number | undefined,
  laterMessagesOfUpsert: unknown[] = [],
) {
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: fromMeId, fromMe: true, remoteJid: "999@s.whatsapp.net" },
        message: { conversation: "your booking is confirmed" },
        messageTimestamp: fromMeTimestamp,
      },
      ...laterMessagesOfUpsert,
    ],
  });
}

function emitGuestMessages(sock: InboxSocket, idPrefix: string) {
  sock.ev.emit(
    "messages.upsert",
    buildNotifyMessageUpsert({
      id: `${idPrefix}-guest`,
      remoteJid: "999@s.whatsapp.net",
      text: "thanks",
      timestamp: nowSeconds(),
    }),
  );
  sock.ev.emit(
    "messages.upsert",
    buildNotifyMessageUpsert({
      id: `${idPrefix}-other`,
      remoteJid: "888@s.whatsapp.net",
      text: "message in another chat",
      timestamp: nowSeconds(),
    }),
  );
}

function guestMessage(id: string, remoteJid: string) {
  return buildNotifyMessageUpsert({ id, remoteJid, text: "thanks", timestamp: nowSeconds() })
    .messages;
}

function createHeldStaffMessageHandler() {
  let release: (result: { ownSend: boolean }) => void = () => {};
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const handler = () =>
    new Promise<{ ownSend: boolean }>((resolve) => {
      release = resolve;
      markStarted();
    });
  return { handler, started, release: (result: { ownSend: boolean }) => release(result) };
}

function agentSenders(onMessage: ReturnType<typeof vi.fn>) {
  return onMessage.mock.calls
    .map(([message]) => (message as { platform: { senderE164: string } }).platform.senderE164)
    .toSorted();
}

async function withInbox<T>(
  run: (inbox: Awaited<ReturnType<typeof openInboxMonitor>>) => Promise<T>,
): Promise<T> {
  const inbox = await openInboxMonitor();
  try {
    return await run(inbox);
  } finally {
    await inbox.listener.close();
  }
}

function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startMs = Date.UTC(2026, 10, 21, 15, 0, 0);
  vi.setSystemTime(startMs);
  return startMs;
}

function holdStaffMessages(pauseMinutes: number) {
  configureStaffPause(pauseMinutes);
  const held = createHeldStaffMessageHandler();
  registerStaffMessageHandler(held.handler);
  return held;
}

async function sendFromPhoneThenGuestMessages(
  fromMeId: string,
  fromMeTimestamp: number,
  deliveries = 1,
) {
  return withInbox(async ({ onMessage, sock }) => {
    for (let delivery = 0; delivery < deliveries; delivery += 1) {
      emitFromPhone(sock, fromMeId, fromMeTimestamp);
      await waitForInboundWorkDrained();
    }
    emitGuestMessages(sock, fromMeId);
    await waitForInboundWorkDrained();
    return agentSenders(onMessage);
  });
}

describe("staff_message hook before the WhatsApp staff pause", () => {
  installWebMonitorInboxUnitTestHooks();

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("starts no staff pause when a plugin claims the fromMe message as its own send", async () => {
    configureStaffPause(30);
    const handler = vi.fn(async () => ({ ownSend: true }));
    registerStaffMessageHandler(handler);
    const sentAtSeconds = nowSeconds();

    const senders = await sendFromPhoneThenGuestMessages("template-1", sentAtSeconds);

    expect(senders).toEqual(["+888", "+999"]);
    expect(handler).toHaveBeenCalledWith(
      {
        channel: "whatsapp",
        accountId: "default",
        conversationId: "+999",
        messageId: "template-1",
        timestampMs: sentAtSeconds * 1000,
      },
      { channelId: "whatsapp", accountId: "default", conversationId: "+999" },
    );
  });

  it.each<{ name: string; handler: () => Promise<unknown>; timeoutMs?: number }>([
    { name: "answers ownSend false", handler: async () => ({ ownSend: false }) },
    { name: "answers nothing", handler: async () => undefined },
    {
      name: "throws",
      handler: async () => {
        throw new Error("api-service unreachable");
      },
    },
    { name: "times out", handler: () => new Promise(() => {}), timeoutMs: 5 },
  ])("starts the staff pause when the plugin $name", async ({ handler, timeoutMs }) => {
    configureStaffPause(30);
    registerStaffMessageHandler(handler, timeoutMs);

    const senders = await sendFromPhoneThenGuestMessages("staff-reply-1", nowSeconds());

    expect(senders).toEqual(["+888"]);
  });

  it("does not ask plugins when the staff pause is off", async () => {
    configureStaffPause(0);
    const handler = vi.fn(async () => ({ ownSend: true }));
    registerStaffMessageHandler(handler);

    const senders = await sendFromPhoneThenGuestMessages("staff-reply-off", nowSeconds());

    expect(senders).toEqual(["+888", "+999"]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not ask plugins about a fromMe message older than the staff pause", async () => {
    configureStaffPause(30);
    const handler = vi.fn(async () => ({ ownSend: true }));
    registerStaffMessageHandler(handler);

    const senders = await sendFromPhoneThenGuestMessages("staff-reply-old", nowSeconds() - 31 * 60);

    expect(senders).toEqual(["+888", "+999"]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps a claimed own send when the same message is delivered again", async () => {
    configureStaffPause(30);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ ownSend: true })
      .mockResolvedValue({ ownSend: false });
    registerStaffMessageHandler(handler);

    const senders = await sendFromPhoneThenGuestMessages("template-redelivered", nowSeconds(), 2);

    expect(senders).toEqual(["+888", "+999"]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("pauses a guest message that arrives while plugins still classify the staff message", async () => {
    const held = holdStaffMessages(30);
    await withInbox(async ({ onMessage, sock }) => {
      emitFromPhone(sock, "staff-reply-slow", nowSeconds());
      await held.started;
      emitGuestMessages(sock, "staff-reply-slow");
      await waitForMessageCalls(onMessage, 1);
      held.release({ ownSend: false });
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888"]);
    });
  });

  it("pauses a guest message until every pending staff message of the chat is classified", async () => {
    configureStaffPause(30);
    let staffMessageCalls = 0;
    let releaseFirstStaffMessage: (result: { ownSend: boolean }) => void = () => {};
    let markBothAsked: () => void = () => {};
    const bothAsked = new Promise<void>((resolve) => {
      markBothAsked = resolve;
    });
    registerStaffMessageHandler(
      () =>
        new Promise((resolve) => {
          staffMessageCalls += 1;
          if (staffMessageCalls === 1) {
            releaseFirstStaffMessage = resolve;
          } else {
            resolve({ ownSend: true });
            markBothAsked();
          }
        }),
    );
    const { onMessage, listener, sock } = await openInboxMonitor();

    try {
      emitFromPhone(sock, "staff-reply-first", nowSeconds());
      emitFromPhone(sock, "template-second", nowSeconds());
      await bothAsked;
      emitGuestMessages(sock, "staff-reply-first");
      await waitForMessageCalls(onMessage, 1);
      releaseFirstStaffMessage({ ownSend: false });
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888"]);
    } finally {
      await listener.close();
    }
  });

  it("lets a guest message through that arrives while plugins classify a staff message they then claim", async () => {
    const held = holdStaffMessages(30);
    await withInbox(async ({ onMessage, sock }) => {
      emitFromPhone(sock, "template-slow", nowSeconds());
      await held.started;
      emitGuestMessages(sock, "template-slow");
      await waitForMessageCalls(onMessage, 1);
      held.release({ ownSend: true });
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888", "+999"]);
    });
  });

  it("pauses a held guest message received before the pending pause ends, even after it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startMs = Date.UTC(2026, 10, 21, 15, 0, 0);
    vi.setSystemTime(startMs);
    configureStaffPause(1);
    const held = createHeldStaffMessageHandler();
    registerStaffMessageHandler(held.handler);
    const { onMessage, listener, sock } = await openInboxMonitor();

    try {
      emitFromPhone(sock, "staff-reply-near-expiry", startMs / 1000 - 58);
      await held.started;
      emitGuestMessages(sock, "staff-reply-near-expiry");
      await waitForMessageCalls(onMessage, 1);
      vi.setSystemTime(startMs + 5_000);
      held.release({ ownSend: false });
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888"]);
    } finally {
      await listener.close();
    }
  });

  it("lets a guest message through that is received after the pending pause ended", async () => {
    const startMs = freezeClock();
    const held = holdStaffMessages(1);
    await withInbox(async ({ onMessage, sock }) => {
      emitFromPhone(sock, "staff-reply-expired", startMs / 1000 - 58);
      await held.started;
      vi.setSystemTime(startMs + 5_000);
      emitGuestMessages(sock, "staff-reply-expired");
      await waitForMessageCalls(onMessage, 1);
      held.release({ ownSend: false });
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888", "+999"]);
    });
  });

  it("pauses a guest message of the same upsert as a staff message whose classification ends after the pause", async () => {
    const startMs = freezeClock();
    const held = holdStaffMessages(1);
    await withInbox(async ({ onMessage, sock }) => {
      emitFromPhone(sock, "staff-reply-batch", startMs / 1000 - 58, [
        ...guestMessage("guest-batch", "999@s.whatsapp.net"),
        ...guestMessage("other-batch", "888@s.whatsapp.net"),
      ]);
      await held.started;
      vi.setSystemTime(startMs + 5_000);
      held.release({ ownSend: false });
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888"]);
    });
  });

  it("records the pause of a staff message whose classification starts after the pause end", async () => {
    const startMs = freezeClock();
    configureStaffPause(1);
    await withInbox(async ({ onMessage, sock }) => {
      emitFromPhone(sock, "staff-reply-late-start", startMs / 1000 - 58, [
        ...guestMessage("guest-late-start", "999@s.whatsapp.net"),
        ...guestMessage("other-late-start", "888@s.whatsapp.net"),
      ]);
      vi.setSystemTime(startMs + 5_000);
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888"]);
    });
  });

  it("pauses a guest message that an existing pause covers while plugins classify a later staff message they then claim", async () => {
    const startMs = freezeClock();
    configureStaffPause(1);
    const held = createHeldStaffMessageHandler();
    registerStaffMessageHandler(
      vi.fn().mockResolvedValueOnce({ ownSend: false }).mockImplementationOnce(held.handler),
    );
    await withInbox(async ({ onMessage, sock }) => {
      emitFromPhone(sock, "staff-reply-earlier", startMs / 1000 - 58);
      await waitForInboundWorkDrained();
      emitFromPhone(sock, "template-later", startMs / 1000);
      await held.started;
      sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [
          ...guestMessage("guest-covered", "999@s.whatsapp.net"),
          ...guestMessage("other-after-covered", "888@s.whatsapp.net"),
        ],
      });
      await waitForMessageCalls(onMessage, 1);
      vi.setSystemTime(startMs + 5_000);
      held.release({ ownSend: true });
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888"]);
    });
  });

  it("keeps a claimed own send on redelivery when no plugin handles staff messages any more", async () => {
    configureStaffPause(30);
    registerStaffMessageHandler(async () => ({ ownSend: true }));
    await withInbox(async ({ onMessage, sock }) => {
      emitFromPhone(sock, "template-unregistered", nowSeconds());
      await waitForInboundWorkDrained();
      resetGlobalHookRunner();
      emitFromPhone(sock, "template-unregistered", nowSeconds());
      await waitForInboundWorkDrained();
      emitGuestMessages(sock, "template-unregistered");
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888", "+999"]);
    });
  });

  it("counts the pause of a replayed staff message without a timestamp from its stored receipt time", async () => {
    const startMs = freezeClock();
    const held = holdStaffMessages(1);
    const key = { id: "staff-reply-replayed", fromMe: true, remoteJid: "999@s.whatsapp.net" };
    const message = serializeWhatsAppDurableInboundMessage({
      key,
      message: { conversation: "your table is ready" },
    });
    await createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID).enqueue(
      createWhatsAppDurableInboundMessageId(key),
      { message, receivedAt: startMs - 30_000 },
      { laneKey: key.remoteJid },
    );
    await withInbox(async ({ onMessage, sock }) => {
      await held.started;
      held.release({ ownSend: false });
      await waitForInboundWorkDrained();
      vi.setSystemTime(startMs + 20_000);
      emitGuestMessages(sock, "staff-reply-replayed-early");
      await waitForInboundWorkDrained();
      vi.setSystemTime(startMs + 40_000);
      emitGuestMessages(sock, "staff-reply-replayed");
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888", "+888", "+999"]);
    });
  });

  it("counts the pause from the receipt time when the staff message timestamp is later", async () => {
    const startMs = freezeClock();
    configureStaffPause(1);
    await withInbox(async ({ onMessage, sock }) => {
      emitFromPhone(sock, "staff-reply-future", startMs / 1000 + 30);
      await waitForInboundWorkDrained();
      vi.setSystemTime(startMs + 50_000);
      emitGuestMessages(sock, "staff-reply-future-early");
      await waitForInboundWorkDrained();
      vi.setSystemTime(startMs + 70_000);
      emitGuestMessages(sock, "staff-reply-future");
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888", "+888", "+999"]);
    });
  });

  it("does not extend the staff pause by the time the plugin takes to answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startMs = Date.UTC(2026, 10, 21, 15, 0, 0);
    vi.setSystemTime(startMs);
    configureStaffPause(1);
    const held = createHeldStaffMessageHandler();
    registerStaffMessageHandler(held.handler);
    const { onMessage, listener, sock } = await openInboxMonitor();

    try {
      emitFromPhone(sock, "staff-reply-no-timestamp", undefined);
      await held.started;
      vi.setSystemTime(startMs + 5_000);
      held.release({ ownSend: false });
      await waitForInboundWorkDrained();
      vi.setSystemTime(startMs + 62_000);
      emitGuestMessages(sock, "staff-reply-no-timestamp");
      await waitForInboundWorkDrained();

      expect(agentSenders(onMessage)).toEqual(["+888", "+999"]);
    } finally {
      await listener.close();
    }
  });

  it("asks plugins once for concurrent deliveries of the same staff message", async () => {
    configureStaffPause(30);
    const held = createHeldStaffMessageHandler();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ ownSend: false })
      .mockImplementationOnce(held.handler)
      .mockResolvedValue({ ownSend: false });
    registerStaffMessageHandler(handler);
    const { onMessage, listener, sock } = await openInboxMonitor();

    try {
      emitFromPhone(sock, "staff-reply-repeated", nowSeconds());
      await waitForInboundWorkDrained();
      emitFromPhone(sock, "staff-reply-repeated", nowSeconds());
      emitFromPhone(sock, "staff-reply-repeated", nowSeconds());
      await held.started;
      emitGuestMessages(sock, "staff-reply-repeated");
      await waitForMessageCalls(onMessage, 1);
      held.release({ ownSend: false });
      await waitForInboundWorkDrained();

      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      await listener.close();
    }
  });
});

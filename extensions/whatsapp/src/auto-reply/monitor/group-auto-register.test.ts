import { prepareCommandOwnerAuthority } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import {
  handleOwnerGroupUnregister,
  handleOwnerInUnregisteredGroup,
  isRegisterCommand,
  isUnregisterCommand,
} from "./group-auto-register.js";
import { applyGroupGating } from "./group-gating.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
import { createWebOnMessageHandler } from "./on-message.js";

const mutateConfigFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    config: { mutateConfigFile: mutateConfigFileMock },
  }),
}));

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

const groupId = "120363000000000000@g.us";
const ownerNumber = "+15551234567";
const botNumber = "+15550000001";
const memberNumber = "+15557654321";
const otherRegisteredGroups = { "120363000000000001@g.us": {} };

let currentConfig: OpenClawConfig;
let persistedConfig: OpenClawConfig | undefined;

function createConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    commands: { ownerAllowFrom: [ownerNumber] },
    channels: { whatsapp: { accounts: { work: {}, other: {} } } },
    ...overrides,
  };
}

function createMessage(body: string, senderE164 = ownerNumber): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    payload: { body },
    platform: {
      chatJid: groupId,
      recipientJid: botNumber,
      sender: { e164: senderE164 },
      selfE164: botNumber,
      reply: vi.fn(async () => ({ kind: "sent", messageId: "reply-1" })) as never,
    },
    admission: {
      accountId: "work",
      conversation: { kind: "group", id: groupId },
      sender: { id: senderE164 },
      senderAccess: { reasonCode: "group_policy_allowed" },
    },
  });
}

function gatingParams(msg: AdmittedWebInboundMessage, groups: Record<string, object>) {
  return {
    cfg: {
      commands: { ownerAllowFrom: [ownerNumber] },
      channels: {
        whatsapp: {
          allowFrom: [ownerNumber],
          groupPolicy: "allowlist",
          accounts: { work: { allowFrom: [ownerNumber], groupPolicy: "allowlist", groups } },
        },
      },
    } as OpenClawConfig,
    msg,
    groupHistoryKey: `whatsapp:group:${groupId}`,
    agentId: "main",
    sessionKey: `agent:main:whatsapp:group:${groupId}`,
    baseMentionConfig: { mentionRegexes: [/@assistant/i] } satisfies MentionConfig,
    groupHistories: new Map<string, GroupHistoryEntry[]>(),
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn(), warn: vi.fn() },
  };
}

const logVerbose = vi.fn();
const groupBinding = (accountId: string | undefined, agentId: string) => ({
  agentId,
  match: {
    channel: "whatsapp",
    ...(accountId ? { accountId } : {}),
    peer: { kind: "group" as const, id: groupId },
  },
});

describe("WhatsApp group registration gating", () => {
  it("reports an owner message in an unregistered group", async () => {
    await expect(
      applyGroupGating(gatingParams(createMessage("/register"), otherRegisteredGroups)),
    ).resolves.toMatchObject({
      shouldProcess: false,
      ownerGroupAction: "unregistered-group",
    });
  });

  it("drops a member message in an unregistered group without an owner action", async () => {
    await expect(
      applyGroupGating(
        gatingParams(createMessage("/register", memberNumber), otherRegisteredGroups),
      ),
    ).resolves.toEqual({ shouldProcess: false });
  });

  it("reports an owner unregister command without a mention", async () => {
    await expect(
      applyGroupGating(gatingParams(createMessage("/unregister"), { [groupId]: {} })),
    ).resolves.toMatchObject({ shouldProcess: false, ownerGroupAction: "unregister" });
  });

  it("does not report an unregister command from a member", async () => {
    const result = await applyGroupGating(
      gatingParams(createMessage("/unregister", memberNumber), { [groupId]: {} }),
    );
    expect(result).not.toHaveProperty("ownerGroupAction");
  });
});

describe("WhatsApp group auto-registration", () => {
  beforeEach(() => {
    currentConfig = createConfig();
    persistedConfig = undefined;
    logVerbose.mockReset();
    mutateConfigFileMock.mockReset();
    mutateConfigFileMock.mockImplementation(async ({ mutate }) => {
      const draft = structuredClone(currentConfig);
      const result = mutate(draft);
      persistedConfig = draft;
      return { previousHash: null, persistedHash: "test-hash", result };
    });
  });

  it.each([
    {
      action: "register",
      body: "/register",
      sender: ownerNumber,
      registered: false,
      revoke: false,
    },
    {
      action: "unregister",
      body: "/unregister",
      sender: ownerNumber,
      registered: true,
      revoke: false,
    },
    {
      action: "notice-rejected",
      body: "hello",
      sender: ownerNumber,
      registered: false,
      revoke: false,
    },
    { action: "notice", body: "hello", sender: ownerNumber, registered: false, revoke: false },
    { action: "denied", body: "/register", sender: memberNumber, registered: false, revoke: false },
    { action: "revoked", body: "/register", sender: ownerNumber, registered: false, revoke: true },
  ])(
    "checks canonical authority through the monitor handler for $action",
    async ({ action, body, sender, registered, revoke }) => {
      currentConfig = createConfig({
        commands: { ownerAllowFrom: [ownerNumber] },
        agents: { entries: { "configured-agent": { default: true } } },
        channels: {
          whatsapp: {
            allowFrom: [ownerNumber, memberNumber],
            groupPolicy: "allowlist",
            accounts: {
              work: {
                allowFrom: [ownerNumber, memberNumber],
                groupPolicy: "allowlist",
                groups: registered ? { [groupId]: {} } : otherRegisteredGroups,
              },
            },
          },
        },
        bindings: registered ? [groupBinding("work", "configured-agent")] : [],
      });
      if (revoke) {
        mutateConfigFileMock.mockImplementationOnce(async ({ mutate }) => {
          const draft = structuredClone(currentConfig);
          draft.commands = { ownerAllowFrom: [memberNumber] };
          mutate(draft);
          persistedConfig = draft;
        });
      }
      const dispatchReplyFromConfig = vi.fn();
      const replyResolver = vi.fn();
      const handler = createWebOnMessageHandler({
        cfg: currentConfig,
        loadConfig: () => currentConfig,
        verbose: false,
        connectionId: "owner-check",
        maxMediaBytes: 1024,
        groupHistoryLimit: 20,
        groupHistories: new Map(),
        groupMemberNames: new Map(),
        backgroundTasks: new Set(),
        replyResolver,
        dispatchReplyFromConfig,
        replyLogger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
      });
      const msg = createMessage(body, sender);
      if (action === "notice-rejected") {
        vi.mocked(msg.platform.reply).mockRejectedValueOnce(new Error("notice rejected"));
        await expect(handler(msg)).rejects.toThrow("notice rejected");
      } else {
        await handler(msg);
      }
      expect(replyResolver).not.toHaveBeenCalled();
      expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
      if (action === "register") {
        expect(persistedConfig?.channels?.whatsapp?.accounts?.work?.groups?.[groupId]).toEqual({
          requireMention: true,
        });
        expect(persistedConfig?.bindings).toEqual([groupBinding("work", "configured-agent")]);
        expect(msg.platform.reply).toHaveBeenCalledWith(
          "Group registered. You can now mention me to chat.",
        );
      } else if (action === "unregister") {
        expect(persistedConfig?.channels?.whatsapp?.accounts?.work?.groups).toEqual({});
        expect(persistedConfig?.bindings).toEqual([]);
        expect(msg.platform.reply).toHaveBeenCalledWith("Group unregistered.");
      } else {
        expect(persistedConfig).toBeUndefined();
        if (action === "notice" || action === "notice-rejected") {
          expect(msg.platform.reply).toHaveBeenCalledWith(
            "Unregistered group. Mention me with /register to enable.",
          );
        } else if (action === "revoked") {
          expect(msg.platform.reply).toHaveBeenCalledWith("Failed to register group.");
        } else {
          expect(msg.platform.reply).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("propagates an owner notice send failure without a sent notice log", async () => {
    const msg = createMessage("hello");
    vi.mocked(msg.platform.reply).mockRejectedValueOnce(new Error("notice rejected"));
    await expect(
      handleOwnerInUnregisteredGroup({
        authority: await prepareCommandOwnerAuthority(currentConfig, {
          channel: "whatsapp",
          accountId: "work",
          senderId: ownerNumber,
        }),
        loadConfig: () => currentConfig,
        commandBody: "hello",
        msg,
        conversationId: groupId,
        accountId: "work",
        agentId: "configured-agent",
        logVerbose,
      }),
    ).rejects.toThrow("notice rejected");
    expect(logVerbose).not.toHaveBeenCalled();
  });

  it("recognizes the command syntax with mentions and invisible characters", () => {
    expect(isRegisterCommand("/register")).toBe(true);
    expect(isRegisterCommand("@assistant​ Register")).toBe(false);
    expect(isRegisterCommand("/status")).toBe(false);
    expect(isUnregisterCommand("@assistant /unregister")).toBe(false);
    expect(isUnregisterCommand("/register")).toBe(false);
  });

  it("sends a notice without a config write when the owner does not register", async () => {
    const msg = createMessage("hello");
    await handleOwnerInUnregisteredGroup({
      authority: await prepareCommandOwnerAuthority(currentConfig, {
        channel: "whatsapp",
        accountId: "work",
        senderId: ownerNumber,
      }),
      loadConfig: () => currentConfig,
      commandBody: "hello",
      msg,
      conversationId: groupId,
      accountId: "work",
      agentId: "configured-agent",
      logVerbose,
    });

    expect(mutateConfigFileMock).not.toHaveBeenCalled();
    expect(msg.platform.reply).toHaveBeenCalledWith(
      "Unregistered group. Mention me with /register to enable.",
    );
  });

  it("registers the group in the account and uses the resolved route target", async () => {
    await handleOwnerInUnregisteredGroup({
      authority: await prepareCommandOwnerAuthority(currentConfig, {
        channel: "whatsapp",
        accountId: "work",
        senderId: ownerNumber,
      }),
      loadConfig: () => currentConfig,
      commandBody: "/register",
      msg: createMessage("/register"),
      conversationId: groupId,
      accountId: "work",
      agentId: "configured-agent",
      logVerbose,
    });

    expect(mutateConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ afterWrite: { mode: "auto" }, mutate: expect.any(Function) }),
    );
    expect(persistedConfig?.channels?.whatsapp?.accounts?.work?.groups?.[groupId]).toEqual({
      requireMention: true,
    });
    expect(persistedConfig?.bindings).toEqual([groupBinding("work", "configured-agent")]);
  });

  it("puts the group binding before a WhatsApp catch-all binding", async () => {
    const catchAll = { agentId: "main", match: { channel: "whatsapp" } };
    currentConfig = createConfig({ bindings: [catchAll] });

    await handleOwnerInUnregisteredGroup({
      authority: await prepareCommandOwnerAuthority(currentConfig, {
        channel: "whatsapp",
        accountId: "work",
        senderId: ownerNumber,
      }),
      loadConfig: () => currentConfig,
      commandBody: "/register",
      msg: createMessage("/register"),
      conversationId: groupId,
      accountId: "work",
      agentId: "work-agent",
      logVerbose,
    });

    expect(persistedConfig?.bindings).toEqual([groupBinding("work", "work-agent"), catchAll]);
  });

  it("keeps group bindings separate across accounts", async () => {
    currentConfig = createConfig({ bindings: [groupBinding("other", "other-agent")] });

    await handleOwnerInUnregisteredGroup({
      authority: await prepareCommandOwnerAuthority(currentConfig, {
        channel: "whatsapp",
        accountId: "work",
        senderId: ownerNumber,
      }),
      loadConfig: () => currentConfig,
      commandBody: "/register",
      msg: createMessage("/register"),
      conversationId: groupId,
      accountId: "work",
      agentId: "work-agent",
      logVerbose,
    });

    expect(persistedConfig?.bindings?.map((binding) => binding.match.accountId)).toEqual([
      "other",
      "work",
    ]);
  });

  it("removes only the matching account binding and group", async () => {
    const bindings = [
      groupBinding("work", "work-agent"),
      groupBinding("other", "other-agent"),
      groupBinding(undefined, "root-agent"),
    ];
    currentConfig = createConfig({
      channels: {
        whatsapp: {
          accounts: {
            work: { groups: { [groupId]: { requireMention: true } } },
            other: { groups: { [groupId]: { requireMention: true } } },
          },
          groups: { [groupId]: { requireMention: true } },
        },
      },
      bindings,
    });

    await handleOwnerGroupUnregister({
      authority: await prepareCommandOwnerAuthority(currentConfig, {
        channel: "whatsapp",
        accountId: "work",
        senderId: ownerNumber,
      }),
      msg: createMessage("/unregister"),
      conversationId: groupId,
      accountId: "work",
      logVerbose,
    });

    expect(persistedConfig?.channels?.whatsapp?.accounts?.work?.groups).toEqual({});
    expect(persistedConfig?.channels?.whatsapp?.accounts?.other?.groups?.[groupId]).toEqual({
      requireMention: true,
    });
    expect(persistedConfig?.channels?.whatsapp?.groups?.[groupId]).toEqual({
      requireMention: true,
    });
    expect(persistedConfig?.bindings).toEqual([bindings[1], bindings[2]]);
  });

  it("removes an unscoped registration only for the default account", async () => {
    currentConfig = createConfig({
      channels: { whatsapp: { groups: { [groupId]: { requireMention: true } } } },
      bindings: [groupBinding(undefined, "root-agent")],
    });

    await handleOwnerGroupUnregister({
      authority: await prepareCommandOwnerAuthority(currentConfig, {
        channel: "whatsapp",
        accountId: "work",
        senderId: ownerNumber,
      }),
      msg: createMessage("/unregister"),
      conversationId: groupId,
      accountId: "default",
      logVerbose,
    });

    expect(persistedConfig?.channels?.whatsapp?.groups).toEqual({});
    expect(persistedConfig?.bindings).toEqual([]);
  });
});

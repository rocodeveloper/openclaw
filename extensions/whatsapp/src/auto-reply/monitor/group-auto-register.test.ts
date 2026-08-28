import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import {
  handleGroupUnregister,
  handleUnregisteredGroup,
  isRegisterCommand,
} from "./group-auto-register.js";

const mutateConfigFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    config: { mutateConfigFile: mutateConfigFileMock },
  }),
}));

const groupId = "120363001234567890@g.us";
const ownerNumber = "+15550000001";
const botNumber = "+15550000002";
const nonOwnerNumber = "+15550000003";

let currentConfig: OpenClawConfig;
let persistedConfig: OpenClawConfig | undefined;

function createConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        accounts: {
          work: {},
          other: {},
        },
      },
    },
    ...overrides,
  };
}

function createMessage(senderE164 = ownerNumber): WebInboundMessage {
  return createTestWebInboundMessage({
    payload: { body: "/register" },
    platform: {
      chatJid: groupId,
      recipientJid: `${botNumber}@s.whatsapp.net`,
      senderE164,
      selfE164: botNumber,
      reply: vi.fn(async () => ({ channel: "whatsapp", messageId: "reply-1" })),
    },
    admission: {
      accountId: "work",
      conversation: { kind: "group", id: groupId },
      sender: { id: senderE164 },
      senderAccess: { reasonCode: "group_policy_allowed" },
    },
  });
}

const mentionConfig = {
  mentionRegexes: [],
  allowFrom: [ownerNumber],
};

function setupMutationMock() {
  currentConfig = createConfig();
  persistedConfig = undefined;
  mutateConfigFileMock.mockReset();
  mutateConfigFileMock.mockImplementation(async ({ mutate }) => {
    const draft = structuredClone(currentConfig);
    const result = mutate(draft);
    persistedConfig = draft;
    return { previousHash: null, persistedHash: "test-hash", result };
  });
}

const logVerbose = vi.fn();

describe("WhatsApp group auto-registration", () => {
  beforeEach(() => {
    setupMutationMock();
    logVerbose.mockReset();
  });

  it("does not let a non-owner register a group", async () => {
    await handleUnregisteredGroup({
      msg: createMessage(nonOwnerNumber),
      conversationId: groupId,
      accountId: "work",
      agentId: "configured-agent",
      baseMentionConfig: mentionConfig,
      logVerbose,
    });

    expect(mutateConfigFileMock).not.toHaveBeenCalled();
    expect(persistedConfig).toBeUndefined();
  });

  it("recognizes its local command syntax without the shared registry", () => {
    expect(isRegisterCommand("/register")).toBe(true);
    expect(isRegisterCommand("register")).toBe(true);
    expect(isRegisterCommand("/status")).toBe(false);
  });

  it("registers the group in the account and uses the resolved route target", async () => {
    await handleUnregisteredGroup({
      msg: createMessage(),
      conversationId: groupId,
      accountId: "work",
      agentId: "configured-agent",
      baseMentionConfig: mentionConfig,
      logVerbose,
    });

    expect(mutateConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ afterWrite: { mode: "auto" }, mutate: expect.any(Function) }),
    );
    expect(persistedConfig?.channels?.whatsapp?.accounts?.work?.groups?.[groupId]).toEqual({
      requireMention: true,
    });
    expect(persistedConfig?.bindings).toEqual([
      {
        agentId: "configured-agent",
        match: {
          channel: "whatsapp",
          accountId: "work",
          peer: { kind: "group", id: groupId },
        },
      },
    ]);
  });

  it("keeps group bindings separate across accounts", async () => {
    currentConfig = createConfig({
      bindings: [
        {
          agentId: "other-agent",
          match: {
            channel: "whatsapp",
            accountId: "other",
            peer: { kind: "group", id: groupId },
          },
        },
      ],
    });

    await handleUnregisteredGroup({
      msg: createMessage(),
      conversationId: groupId,
      accountId: "work",
      agentId: "work-agent",
      baseMentionConfig: mentionConfig,
      logVerbose,
    });

    expect(persistedConfig?.bindings).toHaveLength(2);
    expect(persistedConfig?.bindings?.map((binding) => binding.match.accountId)).toEqual([
      "other",
      "work",
    ]);
  });

  it("does not let a non-owner unregister a group", async () => {
    currentConfig = createConfig({
      bindings: [
        {
          agentId: "work-agent",
          match: {
            channel: "whatsapp",
            accountId: "work",
            peer: { kind: "group", id: groupId },
          },
        },
      ],
    });

    await handleGroupUnregister({
      msg: createMessage(nonOwnerNumber),
      conversationId: groupId,
      accountId: "work",
      baseMentionConfig: mentionConfig,
      logVerbose,
    });

    expect(mutateConfigFileMock).not.toHaveBeenCalled();
  });

  it("removes only the matching account binding and group", async () => {
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
      bindings: [
        {
          agentId: "work-agent",
          match: {
            channel: "whatsapp",
            accountId: "work",
            peer: { kind: "group", id: groupId },
          },
        },
        {
          agentId: "other-agent",
          match: {
            channel: "whatsapp",
            accountId: "other",
            peer: { kind: "group", id: groupId },
          },
        },
        {
          agentId: "legacy-agent",
          match: { channel: "whatsapp", peer: { kind: "group", id: groupId } },
        },
      ],
    });

    await handleGroupUnregister({
      msg: createMessage(),
      conversationId: groupId,
      accountId: "work",
      baseMentionConfig: mentionConfig,
      logVerbose,
    });

    expect(persistedConfig?.channels?.whatsapp?.accounts?.work?.groups).toEqual({});
    expect(persistedConfig?.channels?.whatsapp?.accounts?.other?.groups?.[groupId]).toEqual({
      requireMention: true,
    });
    expect(persistedConfig?.channels?.whatsapp?.groups?.[groupId]).toEqual({
      requireMention: true,
    });
    expect(persistedConfig?.bindings).toEqual([
      currentConfig.bindings?.[1],
      currentConfig.bindings?.[2],
    ]);
  });

  it("cleans up an unscoped legacy registration only for the default account", async () => {
    currentConfig = createConfig({
      channels: { whatsapp: { groups: { [groupId]: { requireMention: true } } } },
      bindings: [
        {
          agentId: "legacy-agent",
          match: { channel: "whatsapp", peer: { kind: "group", id: groupId } },
        },
      ],
    });

    await handleGroupUnregister({
      msg: createMessage(),
      conversationId: groupId,
      accountId: "default",
      baseMentionConfig: mentionConfig,
      logVerbose,
    });

    expect(persistedConfig?.channels?.whatsapp?.groups).toEqual({});
    expect(persistedConfig?.bindings).toEqual([]);
  });
});

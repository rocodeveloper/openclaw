import type { AnyMessageContent, WAMessage } from "baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { checkInboundAccessControl } from "./access-control.js";
import { isRecentOutboundMessage } from "./dedupe.js";
import { hasInboundUserContent } from "./extract.js";
import type { WhatsAppGroupMetadataCacheOwner } from "./group-metadata-cache.js";
import { isJidGroup } from "./runtime-api.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";
import {
  describeStaffPause,
  getActiveStaffPauseEnd,
  isRememberedOwnSend,
  maskChatForLog,
  recordStaffMessage,
  rememberOwnSend,
  resolveStaffPauseEnd,
  resolveStaffPauseMinutes,
} from "./staff-pause.js";

type StaffMessage = {
  chat: string;
  messageId: string | undefined;
  timestampMs: number | undefined;
};

type PendingStaffClassification = { pauseEndsAt: number; ownSend: Promise<boolean> };

export type WhatsAppNormalizedInboundMessage = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createWhatsAppInboundMessageNormalizer>["normalize"]>>
>;

export function createWhatsAppInboundMessageNormalizer(options: {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  accountId: string;
  verbose: boolean;
  socketSession: WhatsAppAttachedSocketSession;
  groupMetadata: WhatsAppGroupMetadataCacheOwner;
  parseTimestampSeconds: (value: unknown) => number | undefined;
  logVerbose: (message: string) => void;
  logInfo: (message: string) => void;
}) {
  const { socketSession, groupMetadata } = options;
  const pendingStaffClassificationsByChat = new Map<string, Set<PendingStaffClassification>>();
  const pendingStaffClassificationsByMessage = new Map<string, PendingStaffClassification>();
  const shouldSkipRecentOutboundEcho = (msg: WAMessage): boolean => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (
      !msg.key?.fromMe ||
      !id ||
      !remoteJid ||
      !isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        alternateRemoteJid: msg.key?.remoteJidAlt,
        messageId: id,
      })
    ) {
      return false;
    }
    options.logVerbose(`Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`);
    return true;
  };

  const isClaimedAsOwnSend = async (message: StaffMessage): Promise<boolean> => {
    const claim = await getGlobalHookRunner()?.runStaffMessage(
      {
        channel: "whatsapp",
        accountId: options.accountId,
        conversationId: message.chat,
        messageId: message.messageId,
        timestampMs: message.timestampMs,
      },
      { channelId: "whatsapp", accountId: options.accountId, conversationId: message.chat },
    );
    return claim?.ownSend === true;
  };

  const logOwnSend = (chat: string) => {
    options.logInfo(
      `staff message: account=${options.accountId} chat=${maskChatForLog(chat)} own send, no pause`,
    );
  };

  const recordStaffPause = (params: { chat: string; pauseMinutes: number; sentAtMs: number }) => {
    const pauseEndsAt = recordStaffMessage({ accountId: options.accountId, ...params });
    options.logInfo(
      `staff message: account=${options.accountId} chat=${maskChatForLog(params.chat)} ${describeStaffPause({ pauseMinutes: params.pauseMinutes, pauseEndsAt })}`,
    );
  };

  const trackPendingClassification = (
    chat: string,
    messageKey: string | undefined,
    pending: PendingStaffClassification,
  ) => {
    const pendingOfChat = pendingStaffClassificationsByChat.get(chat) ?? new Set();
    pendingOfChat.add(pending);
    pendingStaffClassificationsByChat.set(chat, pendingOfChat);
    if (messageKey !== undefined) {
      pendingStaffClassificationsByMessage.set(messageKey, pending);
    }
    const untrack = () => {
      pendingOfChat.delete(pending);
      if (pendingOfChat.size === 0) {
        pendingStaffClassificationsByChat.delete(chat);
      }
      if (messageKey !== undefined) {
        pendingStaffClassificationsByMessage.delete(messageKey);
      }
    };
    void pending.ownSend.then(untrack, untrack);
  };

  const classifyStaffMessage = async (message: StaffMessage & { cfg: OpenClawConfig }) => {
    const pauseMinutes = resolveStaffPauseMinutes({
      cfg: message.cfg,
      accountId: options.accountId,
    });
    const now = Date.now();
    const sentAtMs = Math.min(now, message.timestampMs ?? now);
    const pauseEndsAt = resolveStaffPauseEnd({ pauseMinutes, sentAtMs, now });
    if (pauseEndsAt === undefined || !getGlobalHookRunner()?.hasHooks("staff_message")) {
      recordStaffPause({ chat: message.chat, pauseMinutes, sentAtMs });
      return;
    }
    const ownSendKey =
      message.messageId === undefined
        ? undefined
        : { accountId: options.accountId, chat: message.chat, messageId: message.messageId };
    if (ownSendKey && isRememberedOwnSend(ownSendKey)) {
      logOwnSend(message.chat);
      return;
    }
    const messageKey = ownSendKey && `${ownSendKey.chat}:${ownSendKey.messageId}`;
    const shared =
      messageKey === undefined ? undefined : pendingStaffClassificationsByMessage.get(messageKey);
    if (shared) {
      await shared.ownSend;
      return;
    }
    const ownSend = isClaimedAsOwnSend(message).then((claimed) => {
      if (claimed) {
        if (ownSendKey) {
          rememberOwnSend({ ...ownSendKey, pauseMinutes });
        }
        logOwnSend(message.chat);
      } else {
        recordStaffPause({ chat: message.chat, pauseMinutes, sentAtMs });
      }
      return claimed;
    });
    trackPendingClassification(message.chat, messageKey, { pauseEndsAt, ownSend });
    await ownSend;
  };

  const resolveHeldStaffPauseEnd = async (chat: string): Promise<number | undefined> => {
    const pending = [...(pendingStaffClassificationsByChat.get(chat) ?? [])];
    const outcomes = await Promise.allSettled(
      pending.map((classification) => classification.ownSend),
    );
    const heldPauseEnds = pending
      .filter((_, index) => {
        const outcome = outcomes[index];
        return !(outcome?.status === "fulfilled" && outcome.value);
      })
      .map((classification) => classification.pauseEndsAt);
    return heldPauseEnds.length > 0 ? Math.max(...heldPauseEnds) : undefined;
  };

  const normalize = async (msg: WAMessage) => {
    const receivedAtMs = Date.now();
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid || remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isJidGroup(remoteJid) === true;
    // Gateway-originated echoes must never become new inbound work, including
    // self-chat replies that return on the same upsert stream.
    if (shouldSkipRecentOutboundEcho(msg)) {
      return null;
    }
    // Receipts, presence, and protocol messages share the upsert stream. Gate
    // access control on actual user content to avoid unsolicited pairing replies.
    if (!hasInboundUserContent(msg.message ?? undefined)) {
      return null;
    }

    const participantJid = msg.key?.participant ?? undefined;
    const from = group ? remoteJid : await socketSession.resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? participantJid
        ? await socketSession.resolveInboundJid(participantJid)
        : null
      : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await groupMetadata.get(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampSeconds = options.parseTimestampSeconds(msg.messageTimestamp);
    const messageTimestampMs =
      messageTimestampSeconds !== undefined ? messageTimestampSeconds * 1000 : undefined;
    const accessCfg = options.loadConfig?.() ?? options.cfg;
    const isFromMe = Boolean(msg.key?.fromMe);
    const access = await checkInboundAccessControl({
      cfg: accessCfg,
      accountId: options.accountId,
      from,
      selfE164: socketSession.self.e164 ?? null,
      senderE164,
      senderJid: participantJid,
      group,
      pushName: msg.pushName ?? undefined,
      isFromMe,
      messageTimestampMs,
      connectedAtMs: socketSession.connectedAtMs,
      verbose: options.verbose,
      sock: {
        sendMessage: (jid: string, content: AnyMessageContent) =>
          socketSession.sendTrackedMessage(jid, content),
      },
      remoteJid,
    });
    if (!access.allowed) {
      if (!group && isFromMe && from !== socketSession.self.e164) {
        await classifyStaffMessage({
          cfg: accessCfg,
          chat: from,
          messageId: id,
          timestampMs: messageTimestampMs,
        });
      }
      return null;
    }
    if (
      !group &&
      !isFromMe &&
      resolveStaffPauseMinutes({ cfg: accessCfg, accountId: options.accountId }) > 0
    ) {
      const heldPauseEndsAt = await resolveHeldStaffPauseEnd(from);
      const pauseEndsAt =
        heldPauseEndsAt !== undefined && receivedAtMs < heldPauseEndsAt
          ? heldPauseEndsAt
          : getActiveStaffPauseEnd({ accountId: options.accountId, chat: from });
      if (pauseEndsAt !== undefined) {
        options.logInfo(
          `staff pause active: account=${options.accountId} chat=${maskChatForLog(from)} until ${new Date(pauseEndsAt).toISOString()}, skipping agent`,
        );
        return null;
      }
    }

    return {
      id,
      remoteJid,
      group,
      participantJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access,
    };
  };

  return { normalize, shouldSkipRecentOutboundEcho } as const;
}

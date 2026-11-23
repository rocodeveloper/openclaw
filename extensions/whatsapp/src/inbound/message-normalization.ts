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
  recordStaffPauseEnd,
  rememberOwnSend,
  resolveStaffPauseEnd,
  resolveStaffPauseMinutes,
} from "./staff-pause.js";

type StaffMessage = {
  chat: string;
  messageId: string | undefined;
  timestampMs: number | undefined;
  receivedAtMs: number;
};

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
  const pendingStaffClassificationsByChat = new Map<string, Set<Promise<boolean>>>();
  const pendingStaffClassificationsByMessage = new Map<string, Promise<boolean>>();
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

  const logStaffPause = (chat: string, pauseMinutes: number, pauseEndsAt: number | undefined) => {
    options.logInfo(
      `staff message: account=${options.accountId} chat=${maskChatForLog(chat)} ${describeStaffPause({ pauseMinutes, pauseEndsAt })}`,
    );
  };

  const trackPendingClassification = (
    chat: string,
    messageKey: string | undefined,
    ownSend: Promise<boolean>,
  ) => {
    const pendingOfChat = pendingStaffClassificationsByChat.get(chat) ?? new Set();
    pendingOfChat.add(ownSend);
    pendingStaffClassificationsByChat.set(chat, pendingOfChat);
    if (messageKey !== undefined) {
      pendingStaffClassificationsByMessage.set(messageKey, ownSend);
    }
    const untrack = () => {
      pendingOfChat.delete(ownSend);
      if (pendingOfChat.size === 0) {
        pendingStaffClassificationsByChat.delete(chat);
      }
      if (messageKey !== undefined) {
        pendingStaffClassificationsByMessage.delete(messageKey);
      }
    };
    void ownSend.then(untrack, untrack);
  };

  const classifyStaffMessage = async (message: StaffMessage & { cfg: OpenClawConfig }) => {
    const pauseMinutes = resolveStaffPauseMinutes({
      cfg: message.cfg,
      accountId: options.accountId,
    });
    const sentAtMs = Math.min(message.receivedAtMs, message.timestampMs ?? message.receivedAtMs);
    const pauseEndsAt = resolveStaffPauseEnd({
      pauseMinutes,
      sentAtMs,
      now: message.receivedAtMs,
    });
    if (pauseEndsAt === undefined) {
      logStaffPause(message.chat, pauseMinutes, undefined);
      return;
    }
    const chatKey = { accountId: options.accountId, chat: message.chat };
    const ownSendKey =
      message.messageId === undefined ? undefined : { ...chatKey, messageId: message.messageId };
    if (ownSendKey && isRememberedOwnSend(ownSendKey)) {
      logOwnSend(message.chat);
      return;
    }
    const messageKey = ownSendKey && `${ownSendKey.chat}:${ownSendKey.messageId}`;
    const shared =
      messageKey === undefined ? undefined : pendingStaffClassificationsByMessage.get(messageKey);
    if (shared) {
      await shared;
      return;
    }
    if (!getGlobalHookRunner()?.hasHooks("staff_message")) {
      logStaffPause(message.chat, pauseMinutes, recordStaffPauseEnd({ ...chatKey, pauseEndsAt }));
      return;
    }
    const ownSend = isClaimedAsOwnSend(message).then((claimed) => {
      if (claimed) {
        if (ownSendKey) {
          rememberOwnSend({ ...ownSendKey, pauseMinutes });
        }
        logOwnSend(message.chat);
      } else {
        logStaffPause(message.chat, pauseMinutes, recordStaffPauseEnd({ ...chatKey, pauseEndsAt }));
      }
      return claimed;
    });
    trackPendingClassification(message.chat, messageKey, ownSend);
    await ownSend;
  };

  const resolveGuestPauseEnd = async (
    chat: string,
    receivedAtMs: number,
  ): Promise<number | undefined> => {
    const readPauseEnd = () =>
      getActiveStaffPauseEnd({ accountId: options.accountId, chat, receivedAtMs });
    const existingPauseEnd = readPauseEnd();
    if (existingPauseEnd !== undefined) {
      return existingPauseEnd;
    }
    await Promise.allSettled(pendingStaffClassificationsByChat.get(chat) ?? []);
    return readPauseEnd();
  };

  const normalize = async (msg: WAMessage, receivedAtMs: number) => {
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
          receivedAtMs,
        });
      }
      return null;
    }
    if (
      !group &&
      !isFromMe &&
      resolveStaffPauseMinutes({ cfg: accessCfg, accountId: options.accountId }) > 0
    ) {
      const pauseEndsAt = await resolveGuestPauseEnd(from, receivedAtMs);
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

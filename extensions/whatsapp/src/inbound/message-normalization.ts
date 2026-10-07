import type { AnyMessageContent, WAMessage } from "baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  checkInboundAccessControl,
  type AcceptedInboundAccessControlResult,
} from "./access-control.js";
import { isRecentOutboundMessage } from "./dedupe.js";
import { hasInboundUserContent } from "./extract.js";
import type { WhatsAppGroupMetadataCacheOwner } from "./group-metadata-cache.js";
import { isJidGroup } from "./runtime-api.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";
import {
  describeStaffPause,
  getActiveStaffPauseEnd,
  maskChatForLog,
  recordStaffMessage,
  resolveStaffPauseMinutes,
} from "./staff-pause.js";

export type WhatsAppNormalizedInboundMessage = {
  id?: string;
  remoteJid: string;
  group: boolean;
  participantJid?: string;
  from: string;
  senderE164: string | null;
  groupSubject?: string;
  groupParticipants?: string[];
  messageTimestampMs?: number;
  access: AcceptedInboundAccessControlResult;
};

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

  const normalize = async (msg: WAMessage): Promise<WhatsAppNormalizedInboundMessage | null> => {
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
        const pauseMinutes = resolveStaffPauseMinutes({
          cfg: accessCfg,
          accountId: options.accountId,
        });
        const pauseEndsAt = recordStaffMessage({
          accountId: options.accountId,
          chat: from,
          pauseMinutes,
          sentAtMs: messageTimestampMs,
        });
        options.logInfo(
          `staff message: account=${options.accountId} chat=${maskChatForLog(from)} ${describeStaffPause({ pauseMinutes, pauseEndsAt })}`,
        );
      }
      return null;
    }
    if (
      !group &&
      !isFromMe &&
      resolveStaffPauseMinutes({ cfg: accessCfg, accountId: options.accountId }) > 0
    ) {
      const pauseEndsAt = getActiveStaffPauseEnd({ accountId: options.accountId, chat: from });
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

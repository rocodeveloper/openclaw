const GROUP_JID_RE = /^[0-9-]+@g\.us$/;

export type WhatsAppGroupScope = { agentId: string; groupJid: string };

export function parseWhatsAppGroupSession(sessionKey: unknown): WhatsAppGroupScope | null {
  if (typeof sessionKey !== "string" || !sessionKey) {
    return null;
  }
  const [prefix, agentId, channel, kind, groupJid] = sessionKey.split(":");
  if (prefix !== "agent" || !agentId || channel !== "whatsapp" || kind !== "group" || !groupJid) {
    return null;
  }
  if (!GROUP_JID_RE.test(groupJid)) {
    return null;
  }
  return { agentId, groupJid };
}

export function resolveCommandGroup(
  ctx: { channel?: string; channelId?: string; sessionKey?: string } | undefined,
): WhatsAppGroupScope | null {
  if (ctx?.channel !== "whatsapp" && ctx?.channelId !== "whatsapp") {
    return null;
  }
  return parseWhatsAppGroupSession(ctx?.sessionKey);
}

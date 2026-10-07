export async function replaceMentionIdsWithPhoneNumbers(params: {
  body: string;
  mentionedJids: readonly string[] | undefined;
  resolveInboundJid: (jid: string) => Promise<string | null>;
}): Promise<string> {
  let body = params.body;
  for (const jid of params.mentionedJids ?? []) {
    const mentionId = jid.replace(/@.*$/, "").replace(/:\d+$/, "");
    const e164 = await params.resolveInboundJid(jid);
    if (!e164 || e164 === `+${mentionId}` || !/^\d+$/.test(mentionId)) {
      continue;
    }
    body = body.replace(new RegExp(`@${mentionId}\\b`, "g"), `@${e164.replace(/^\+/, "")}`);
  }
  return body;
}

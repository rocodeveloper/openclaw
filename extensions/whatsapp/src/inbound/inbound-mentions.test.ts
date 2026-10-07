import { describe, expect, it } from "vitest";
import { replaceMentionIdsWithPhoneNumbers } from "./inbound-mentions.js";

const resolveInboundJid = async (jid: string) =>
  jid.startsWith("277038292303944") ? "+15551234567" : null;

describe("replaceMentionIdsWithPhoneNumbers", () => {
  it("replaces LID mentions with the resolved phone number", async () => {
    await expect(
      replaceMentionIdsWithPhoneNumbers({
        body: "hi @277038292303944 and @277038292303944",
        mentionedJids: ["277038292303944:9@lid"],
        resolveInboundJid,
      }),
    ).resolves.toBe("hi @15551234567 and @15551234567");
  });

  it("keeps mentions that do not resolve or already use the phone number", async () => {
    await expect(
      replaceMentionIdsWithPhoneNumbers({
        body: "hi @15557654321 and @2770382923039440",
        mentionedJids: ["15557654321@s.whatsapp.net", "999@lid"],
        resolveInboundJid: async (jid) => (jid.startsWith("1555") ? "+15557654321" : null),
      }),
    ).resolves.toBe("hi @15557654321 and @2770382923039440");
  });

  it("does not replace a mention id inside a longer number", async () => {
    await expect(
      replaceMentionIdsWithPhoneNumbers({
        body: "ref @2770382923039441",
        mentionedJids: ["277038292303944@lid"],
        resolveInboundJid,
      }),
    ).resolves.toBe("ref @2770382923039441");
  });
});

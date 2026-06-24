// Whatsapp tests cover outbound mentions plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveWhatsAppOutboundMentions } from "./outbound-mentions.js";

describe("resolveWhatsAppOutboundMentions", () => {
  it("resolves phone-number tokens to WhatsApp participant JIDs", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: "hi @+15551234567 and @15557654321",
        participants: [{ id: "15551234567@s.whatsapp.net" }, { id: "15557654321@s.whatsapp.net" }],
      }),
    ).toEqual({
      text: "hi @+15551234567 and @15557654321",
      mentionedJids: ["15551234567@s.whatsapp.net", "15557654321@s.whatsapp.net"],
    });
  });

  it("rewrites phone-number tokens to LID mention text without device suffixes", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: "ping @+5511976136970",
        participants: [
          {
            id: "277038292303944:2@lid",
            phoneNumber: "5511976136970@s.whatsapp.net",
          },
        ],
      }),
    ).toEqual({
      text: "ping @277038292303944",
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it("uses resolved E.164 metadata when LID participant records omit phoneNumber", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: "ping @15551234567",
        participants: [
          {
            id: "277038292303944@lid",
            e164: "+15551234567",
          },
        ],
      }),
    ).toEqual({
      text: "ping @277038292303944",
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it("prefers explicit LID metadata over a phone JID id", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: "ping @15551234567 and @277038292303944",
        participants: [
          {
            id: "15551234567@s.whatsapp.net",
            lid: "277038292303944@lid",
          },
        ],
      }),
    ).toEqual({
      text: "ping @277038292303944 and @277038292303944",
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it("uses bare digit tokens for LIDs before phone numbers when participant keys collide", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: "ping @277038292303944 and @+277038292303944",
        participants: [{ id: "277038292303944@s.whatsapp.net" }, { id: "277038292303944@lid" }],
      }),
    ).toEqual({
      text: "ping @277038292303944 and @+277038292303944",
      mentionedJids: ["277038292303944@lid", "277038292303944@s.whatsapp.net"],
    });
  });

  it("applies LID rewrites by match position while skipping code spans", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: [
          "visible @+5511976136970",
          "`inline @+5511976136970`",
          "```",
          "fenced @+5511976136970",
          "```",
          "again @+5511976136970",
        ].join("\n"),
        participants: [
          {
            id: "277038292303944:9@lid",
            phoneNumber: "5511976136970@s.whatsapp.net",
          },
        ],
      }),
    ).toEqual({
      text: [
        "visible @277038292303944",
        "`inline @+5511976136970`",
        "```",
        "fenced @+5511976136970",
        "```",
        "again @277038292303944",
      ].join("\n"),
      mentionedJids: ["277038292303944@lid"],
    });
  });

  it("does not mention numeric prefixes inside longer tokens", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: "literal @15551234567abc and x@15551234567",
        participants: [{ id: "15551234567@s.whatsapp.net" }],
      }),
    ).toEqual({
      text: "literal @15551234567abc and x@15551234567",
      mentionedJids: [],
    });
  });

  it("direct-maps mentions for DMs and groups without a usable participant list", () => {
    // DM: no group participant lookup, so map @<digits> straight to the phone JID
    // (this is how owner reminders render @Name — fork commits 3dbdb85a65/7f5a384ae5).
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "15551234567@s.whatsapp.net",
        text: "hi @+15551234567",
        participants: [{ id: "15551234567@s.whatsapp.net" }],
      }),
    ).toEqual({
      text: "hi @+15551234567",
      mentionedJids: ["15551234567@s.whatsapp.net"],
    });
    // Group send with no participant list loaded (e.g. the fast-send reminder path).
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "40723572512-1515751976@g.us",
        text: "Reminder @40723572512: do the thing",
      }),
    ).toEqual({
      text: "Reminder @40723572512: do the thing",
      mentionedJids: ["40723572512@s.whatsapp.net"],
    });
  });

  it("does not add mention metadata for unmatched group participants", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: "hi @+15551234567",
        participants: [{ id: "15550000000@s.whatsapp.net" }],
      }),
    ).toEqual({ text: "hi @+15551234567", mentionedJids: [] });
  });
});

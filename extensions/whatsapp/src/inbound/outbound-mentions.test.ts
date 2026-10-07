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

  it.each([
    { text: "ping @+15557654321" },
    { text: "literal \\` ping @+15557654321" },
    { text: "literal \\\\\\` ping @+15557654321" },
    { text: "inside ``notify ` @+15557654321`` then @+15557654321" },
  ])(
    "keeps the phone token when a LID participant record carries a phoneNumber: $text",
    ({ text }) => {
      expect(
        resolveWhatsAppOutboundMentions({
          chatJid: "120363000000000000@g.us",
          text,
          participants: [
            {
              id: "277038292303944:2@lid",
              phoneNumber: "15557654321@s.whatsapp.net",
            },
          ],
        }),
      ).toEqual({
        text,
        mentionedJids: ["15557654321@s.whatsapp.net"],
      });
    },
  );

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
      text: "ping @15551234567",
      mentionedJids: ["15551234567@s.whatsapp.net"],
    });
  });

  it("prefers a phone JID over explicit LID metadata and leaves the text alone", () => {
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
      text: "ping @15551234567 and @277038292303944",
      mentionedJids: ["15551234567@s.whatsapp.net"],
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

  it("skips mentions inside inline code and fenced blocks", () => {
    const text = [
      "visible @+15551234567",
      "`inline @+15559999999`",
      "```",
      "fenced @+15558888888",
      "```",
      "again @+15551234567",
    ].join("\n");
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text,
        participants: [
          { id: "15551234567@s.whatsapp.net" },
          { id: "15559999999@s.whatsapp.net" },
          { id: "15558888888@s.whatsapp.net" },
        ],
      }),
    ).toEqual({
      text,
      mentionedJids: ["15551234567@s.whatsapp.net"],
    });
  });

  it("applies LID rewrites by match position when only a LID is known", () => {
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000000@g.us",
        text: ["visible @+100000000000001", "`inline @+100000000000001`"].join("\n"),
        participants: [{ id: "100000000000001:9@lid" }],
      }),
    ).toEqual({
      text: ["visible @100000000000001", "`inline @+100000000000001`"].join("\n"),
      mentionedJids: ["100000000000001@lid"],
    });
  });

  it.each([
    "Run `notify @+5511976136970",
    "Run `notify\n@+5511976136970",
    "Run ``notify ` @+5511976136970",
    "Run ``notify ` @+5511976136970``",
    "literal \\\\` inside @+5511976136970",
  ])(
    "does not rewrite or mention phone numbers inside balanced or unterminated inline code: %j",
    (text) => {
      expect(
        resolveWhatsAppOutboundMentions({
          chatJid: "120363000000000000@g.us",
          text,
          participants: [
            {
              id: "277038292303944@lid",
              phoneNumber: "5511976136970@s.whatsapp.net",
            },
          ],
        }),
      ).toEqual({ text, mentionedJids: [] });
    },
  );

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
    expect(
      resolveWhatsAppOutboundMentions({
        chatJid: "120363000000000001@g.us",
        text: "Reminder @15551234567: do the thing",
      }),
    ).toEqual({
      text: "Reminder @15551234567: do the thing",
      mentionedJids: ["15551234567@s.whatsapp.net"],
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

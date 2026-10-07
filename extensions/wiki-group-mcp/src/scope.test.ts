import { describe, expect, it } from "vitest";
import { parseWhatsAppGroupSession, resolveCommandGroup } from "./scope.js";

describe("wiki-group-mcp scope", () => {
  it("extracts a group only from a WhatsApp group session", () => {
    expect(
      parseWhatsAppGroupSession("agent:whatsapp-group:whatsapp:group:120363000000000000@g.us"),
    ).toEqual({
      agentId: "whatsapp-group",
      groupJid: "120363000000000000@g.us",
    });
    expect(
      parseWhatsAppGroupSession("agent:main:whatsapp:direct:15551234567@s.whatsapp.net"),
    ).toBeNull();
    expect(
      parseWhatsAppGroupSession("agent:main:discord:group:120363000000000000@g.us"),
    ).toBeNull();
  });

  it("requires the WhatsApp channel for command scope", () => {
    const sessionKey = "agent:whatsapp-group:whatsapp:group:120363000000000000@g.us";
    expect(resolveCommandGroup({ channel: "discord", sessionKey })).toBeNull();
    expect(resolveCommandGroup({ channel: "whatsapp", sessionKey })?.groupJid).toBe(
      "120363000000000000@g.us",
    );
  });
});

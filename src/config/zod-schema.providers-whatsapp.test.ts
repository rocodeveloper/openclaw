import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

describe("WhatsAppConfigSchema", () => {
  it("preserves group and direct prompts at root and account scope", () => {
    const config = {
      groups: { "*": { systemPrompt: "Default group prompt" } },
      direct: { "+15551234567": { systemPrompt: "Direct VIP" } },
      accounts: {
        work: {
          groups: { "456@g.us": { systemPrompt: "Project team" } },
          direct: { "*": { systemPrompt: "Work direct default" } },
        },
      },
    };
    expect(WhatsAppConfigSchema.parse(config)).toMatchObject(config);
  });

  it("preserves a disabled channel messageReceived hook", () => {
    expect(
      WhatsAppConfigSchema.parse({ pluginHooks: { messageReceived: false } }).pluginHooks,
    ).toEqual({ messageReceived: false });
  });
});

describe("WhatsApp staff pause config validation", () => {
  const bundledWhatsAppSchema = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (entry) => entry.channelId === "whatsapp",
  )?.schema as Record<string, unknown>;

  function validateWithBundledSchema(value: unknown) {
    return validateJsonSchemaValue({
      schema: bundledWhatsAppSchema,
      cacheKey: "test:whatsapp-staff-pause",
      value: structuredClone(value),
      applyDefaults: true,
    });
  }

  it("accepts a config without staffPause", () => {
    const result = WhatsAppConfigSchema.safeParse({ accounts: { "acct-a": {} } });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.staffPause).toBe(undefined);
      expect(result.data.accounts?.["acct-a"]?.staffPause).toBe(undefined);
    }
  });

  it("accepts the channel default and an account override", () => {
    const config = {
      staffPause: { minutes: 30 },
      accounts: {
        "acct-a": { staffPause: { minutes: 0 } },
        work: { staffPause: { minutes: 1440 } },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.staffPause?.minutes).toBe(30);
      expect(result.data.accounts?.["acct-a"]?.staffPause?.minutes).toBe(0);
      expect(result.data.accounts?.work?.staffPause?.minutes).toBe(1440);
    }
    expect(validateWithBundledSchema(config).ok).toBe(true);
  });

  it.each([
    ["a negative value", { minutes: -1 }],
    ["a value above one day", { minutes: 1441 }],
    ["a fraction", { minutes: 1.5 }],
    ["a string", { minutes: "30" }],
    ["an unknown key", { minutes: 30, seconds: 5 }],
  ])("rejects %s at the channel level and the account level", (_name, staffPause) => {
    expect(WhatsAppConfigSchema.safeParse({ staffPause }).success).toBe(false);
    expect(WhatsAppConfigSchema.safeParse({ accounts: { "acct-a": { staffPause } } }).success).toBe(
      false,
    );
    expect(validateWithBundledSchema({ staffPause }).ok).toBe(false);
    expect(validateWithBundledSchema({ accounts: { "acct-a": { staffPause } } }).ok).toBe(false);
  });
});

import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const whatsAppChannelConfigUiHints = {
  "": {
    label: "WhatsApp",
    help: "WhatsApp channel provider configuration for access policy and direct-message routing safety.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "WhatsApp",
    dmPolicy: { channelKey: "whatsapp" },
  }),
  allowFrom: { presentation: "phone-number" },
  defaultTo: { presentation: "phone-number" },
  groupAllowFrom: { presentation: "phone-number" },
  "accounts.*.allowFrom.*": { presentation: "phone-number" },
  "accounts.*.defaultTo": { presentation: "phone-number" },
  "accounts.*.groupAllowFrom.*": { presentation: "phone-number" },
  selfChatMode: {
    label: "WhatsApp Self-Phone Mode",
    help: "Same-phone setup (bot uses your personal WhatsApp number).",
  },
  direct: {
    label: "WhatsApp Direct Chat Overrides",
    help: 'Per-conversation overrides keyed by WhatsApp DM id. Applied after a DM is already admitted by dmPolicy; "*" supplies a default without admitting anyone.',
  },
  staffPause: {
    label: "WhatsApp Staff Pause",
    help: "Pause the agent in a direct chat after a staff member sends a message from the linked phone.",
  },
  "staffPause.minutes": {
    label: "WhatsApp Staff Pause Minutes",
    help: "Minutes to pause the agent in a direct chat after a message from the linked phone. Absent or 0 keeps the pause off; maximum 1440.",
  },
  pluginHooks: {
    label: "WhatsApp Plugin Hooks",
    help: "Opt in to broadcasting inbound WhatsApp events to plugins. Payloads carry personal content, so only enable it for plugins you trust.",
  },
  ...createChannelConfigUiHints({ channelLabel: "WhatsApp", configWrites: true }),
  "actions.calls": {
    label: "WhatsApp Voice Calls",
    help: "Expose the experimental requester-bound WhatsApp voice-call tool. Default: false. Requires a separately paired MeowCaller CLI.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "WhatsApp",
    mentionPatterns: {
      targetDescription: "WhatsApp conversation IDs",
      policyTargetDescription: "WhatsApp conversation IDs such as 123@g.us",
    },
  }),
} satisfies Record<string, ChannelConfigUiHint>;

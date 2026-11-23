export type PluginHookStaffMessageEvent = {
  channel: string;
  accountId: string;
  conversationId: string;
  messageId?: string;
  timestampMs?: number;
};

export type PluginHookStaffMessageContext = {
  channelId: string;
  accountId: string;
  conversationId: string;
};

export type PluginHookStaffMessageResult = {
  ownSend?: boolean;
};

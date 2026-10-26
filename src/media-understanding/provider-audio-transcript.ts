import { randomUUID } from "node:crypto";
import { MAX_AUDIO_BYTES } from "@openclaw/media-core/constants";
import type { RuntimeMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaFact } from "../media/media-facts.js";
import { audioTranscriptKey, transcribeAudioOnce } from "./audio-delivery.js";
import { resolveMediaUnderstandingScope } from "./scope.js";

export type AudioTranscriptScope = Pick<
  RuntimeMsgContext,
  "AccountId" | "SessionKey" | "MessageSid" | "Surface" | "Provider" | "ChatType"
> & { agentId?: string };

type ProviderAudioTranscriptParams = {
  fact: MediaFact;
  bytes: Uint8Array;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  scope?: AudioTranscriptScope;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};

export async function transcribeProviderAudioFact(
  params: ProviderAudioTranscriptParams,
): Promise<string | undefined> {
  const scope = params.scope ?? {};
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  if (
    params.cfg.tools?.media?.audio?.enabled === false ||
    resolveMediaUnderstandingScope({
      scope: params.cfg.tools?.media?.audio?.scope,
      sessionKey: scope.SessionKey,
      channel: scope.Surface ?? scope.Provider,
      chatType: scope.ChatType,
    }) === "deny"
  ) {
    return undefined;
  }
  const key = audioTranscriptKey(params.bytes, [
    scope.agentId ?? params.agentDir,
    scope.AccountId ?? "default",
    scope.SessionKey,
    scope.Surface ?? scope.Provider,
    scope.ChatType,
    (scope.agentId || params.agentDir) && scope.SessionKey
      ? (scope.MessageSid ?? randomUUID())
      : randomUUID(),
    params.fact.messageId,
  ]);
  const transcript = await transcribeAudioOnce(key, async () => {
    const {
      buildProviderRegistry,
      createMediaAttachmentCache,
      normalizeMediaAttachments,
      resolveMediaAttachmentLocalRoots,
      runCapability,
    } = await import("./runner.js");
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    const workspaceDir = params.fact.workspaceDir ?? params.workspaceDir;
    const ctx = {
      ...scope,
      media: [{ ...params.fact, kind: "audio" as const, transcribed: false }],
    };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media, {
      localPathRoots: resolveMediaAttachmentLocalRoots({ cfg: params.cfg, ctx, workspaceDir }),
      workspaceDir,
      ssrfPolicy: params.cfg.tools?.web?.fetch?.ssrfPolicy,
    });
    try {
      const result = await runCapability({
        capability: "audio",
        cfg: params.cfg,
        ctx,
        media,
        attachments: cache,
        agentId: scope.agentId,
        agentDir: params.agentDir,
        workspaceDir,
        providerRegistry: buildProviderRegistry(undefined, params.cfg),
        config: params.cfg.tools?.media?.audio,
      });
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
      return result.outputs.find((entry) => entry.kind === "audio.transcription")?.text;
    } finally {
      await cache.cleanup();
    }
  });
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  return transcript;
}

export async function primeAudioTranscript(params: {
  fact: MediaFact;
  ctx: RuntimeMsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<void> {
  const {
    createMediaAttachmentCache,
    normalizeMediaAttachments,
    resolveMediaAttachmentLocalRoots,
  } = await import("./runner.js");
  const ctx = { ...params.ctx, media: [params.fact] };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    localPathRoots: resolveMediaAttachmentLocalRoots({
      cfg: params.cfg,
      ctx,
      workspaceDir: params.workspaceDir,
    }),
    workspaceDir: params.workspaceDir,
    ssrfPolicy: params.cfg.tools?.web?.fetch?.ssrfPolicy,
  });
  try {
    const { buffer } = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: Math.min(
        MAX_AUDIO_BYTES,
        params.cfg.tools?.media?.audio?.maxBytes ?? MAX_AUDIO_BYTES,
      ),
      timeoutMs: (params.cfg.tools?.media?.audio?.timeoutSeconds ?? 60) * 1000,
    });
    await transcribeProviderAudioFact({
      ...params,
      bytes: buffer,
      scope: { ...params.ctx, agentId: params.agentId },
    });
  } finally {
    await cache.cleanup();
  }
}

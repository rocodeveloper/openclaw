import { MAX_AUDIO_BYTES } from "@openclaw/media-core/constants";
import { MediaUnderstandingSkipError } from "../../packages/media-understanding-common/src/errors.js";
import type { RuntimeMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaFact } from "../media/media-facts.js";
import {
  assertMediaExecutionCurrent,
  audioTranscriptKey,
  transcribeAudioOnce,
  type MediaExecutionGuards,
} from "./audio-delivery.js";
import { resolveMediaUnderstandingScope } from "./scope.js";

export type AudioTranscriptScope = Pick<
  RuntimeMsgContext,
  "AccountId" | "SessionKey" | "Surface" | "Provider" | "ChatType"
> & { agentId?: string };

type ProviderAudioTranscriptParams = MediaExecutionGuards & {
  fact: MediaFact;
  bytes: Uint8Array;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  scope?: AudioTranscriptScope;
};

export async function transcribeProviderAudioFact(
  params: ProviderAudioTranscriptParams,
): Promise<string | undefined> {
  const scope = params.scope ?? {};
  assertMediaExecutionCurrent(params);
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
  const {
    buildProviderRegistry,
    createMediaAttachmentCache,
    normalizeMediaAttachments,
    resolveMediaAttachmentLocalRoots,
    runCapability,
  } = await import("./runner.js");
  assertMediaExecutionCurrent(params);
  const workspaceDir = params.fact.workspaceDir ?? params.workspaceDir;
  const ctx = {
    ...scope,
    media: [{ ...params.fact, kind: "audio" as const, transcribed: false }],
  };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    localPathRoots: resolveMediaAttachmentLocalRoots({ cfg: params.cfg, ctx, workspaceDir }),
    includeDefaultLocalPathRoots: false,
    workspaceDir,
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
      signal: params.signal,
    });
    assertMediaExecutionCurrent(params);
    const key = audioTranscriptKey(buffer, [
      scope.agentId ?? params.agentDir,
      scope.AccountId ?? "default",
      scope.SessionKey,
      scope.Surface ?? scope.Provider,
      scope.ChatType,
      params.fact.messageId,
    ]);
    const transcribe = async () => {
      assertMediaExecutionCurrent(params);
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
        signal: params.signal,
        assertCurrent: params.assertCurrent,
      });
      assertMediaExecutionCurrent(params);
      return result.outputs.find((entry) => entry.kind === "audio.transcription")?.text;
    };
    const transcript =
      (scope.agentId || params.agentDir) && scope.SessionKey && params.fact.messageId
        ? await transcribeAudioOnce(key, transcribe, params)
        : await transcribe();
    assertMediaExecutionCurrent(params);
    return transcript;
  } catch (error) {
    assertMediaExecutionCurrent(params);
    if (error instanceof MediaUnderstandingSkipError) {
      return undefined;
    }
    throw error;
  } finally {
    await cache.cleanup();
  }
}

export async function primeAudioTranscript(
  params: MediaExecutionGuards & {
    fact: MediaFact;
    ctx: RuntimeMsgContext;
    cfg: OpenClawConfig;
    agentId?: string;
    agentDir?: string;
    workspaceDir?: string;
  },
): Promise<void> {
  assertMediaExecutionCurrent(params);
  const {
    createMediaAttachmentCache,
    normalizeMediaAttachments,
    resolveMediaAttachmentLocalRoots,
  } = await import("./runner.js");
  assertMediaExecutionCurrent(params);
  const ctx = { ...params.ctx, media: [params.fact] };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    localPathRoots: resolveMediaAttachmentLocalRoots({
      cfg: params.cfg,
      ctx,
      workspaceDir: params.workspaceDir,
    }),
    includeDefaultLocalPathRoots: false,
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
      signal: params.signal,
    });
    assertMediaExecutionCurrent(params);
    await transcribeProviderAudioFact({
      ...params,
      bytes: buffer,
      scope: { ...params.ctx, agentId: params.agentId },
    });
  } finally {
    await cache.cleanup();
  }
}

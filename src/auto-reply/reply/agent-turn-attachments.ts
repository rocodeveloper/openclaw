/** Resolves media attachments available to the current agent turn. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment as AgentTurnAttachment } from "../../acp/control-plane/manager.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { MediaAttachment } from "../../media-understanding/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { MsgContext } from "../templating.js";
import {
  type RecentInboundHistoryImage,
  resolveRecentInboundHistoryImages,
} from "./history-media.js";
import { hasInboundMedia } from "./inbound-media.js";

const agentTurnMediaRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-media.runtime.js"),
);

/** Lazily loads media runtime dependencies for agent-turn attachments. */
export function loadAgentTurnMediaRuntime() {
  return agentTurnMediaRuntimeLoader.load();
}

/** Runtime surface needed to resolve agent-turn media attachments. */
type AgentTurnAttachmentRuntime = Pick<
  Awaited<ReturnType<typeof loadAgentTurnMediaRuntime>>,
  | "MediaAttachmentCache"
  | "isMediaUnderstandingSkipError"
  | "normalizeAttachments"
  | "resolveMediaAttachmentLocalRoots"
>;

const AGENT_TURN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_TURN_ATTACHMENT_TIMEOUT_MS = 1_000;
const AGENT_TURN_AUDIO_MEDIA_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

function isImageAgentTurnAttachment(attachment: MediaAttachment): boolean {
  return normalizeAgentTurnMediaType(attachment.mime).startsWith("image/");
}

function normalizeAgentTurnMediaType(mediaType: string | undefined): string {
  return (mediaType ?? "application/octet-stream").trim().toLowerCase();
}

function isAudioAgentTurnAttachment(attachment: MediaAttachment): boolean {
  const mediaType = normalizeAgentTurnMediaType(attachment.mime).split(";", 1)[0]?.trim();
  return AGENT_TURN_AUDIO_MEDIA_TYPES.has(mediaType);
}

function isAgentTurnAudioCandidate(attachment: MediaAttachment): boolean {
  return normalizeAgentTurnMediaType(attachment.mime).startsWith("audio/");
}

function isSupportedAgentTurnAttachment(
  attachment: MediaAttachment,
  includeAudio: boolean,
): boolean {
  if (isImageAgentTurnAttachment(attachment)) {
    return true;
  }
  return includeAudio && !attachment.alreadyTranscribed && isAudioAgentTurnAttachment(attachment);
}

function hasInboundHistoryMedia(ctx: MsgContext): boolean {
  return (
    Array.isArray(ctx.InboundHistory) &&
    ctx.InboundHistory.some((entry) => Array.isArray(entry.media) && entry.media.length > 0)
  );
}

export async function canIncludeNativeAgentTurnAudio(params: {
  ctx: MsgContext;
  runtime?: AgentTurnAttachmentRuntime;
}): Promise<boolean> {
  if (!hasInboundMedia(params.ctx)) {
    return false;
  }
  const runtime = params.runtime ?? (await loadAgentTurnMediaRuntime());
  const audioAttachments = runtime
    .normalizeAttachments(params.ctx)
    .filter(isAgentTurnAudioCandidate);
  return (
    audioAttachments.length > 0 &&
    audioAttachments.every(
      (attachment) =>
        !attachment.alreadyTranscribed &&
        Boolean(normalizeOptionalString(attachment.path)) &&
        isAudioAgentTurnAttachment(attachment),
    )
  );
}

export async function resolveAgentTurnAttachments(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  runtime?: AgentTurnAttachmentRuntime;
  includeRecentHistoryImages?: boolean;
  includeAttachmentIndexes?: boolean;
  includeAudio?: boolean;
}): Promise<{
  attachments: AgentTurnAttachment[];
  attachmentIndexes?: number[];
  recentHistoryImages: RecentInboundHistoryImage[];
}> {
  const includeRecentHistoryImages = params.includeRecentHistoryImages ?? true;
  const includeAudio = params.includeAudio ?? true;
  if (
    !hasInboundMedia(params.ctx) &&
    !(includeRecentHistoryImages && hasInboundHistoryMedia(params.ctx))
  ) {
    return { attachments: [], recentHistoryImages: [] };
  }
  const runtime = params.runtime ?? (await loadAgentTurnMediaRuntime());
  const currentAttachments = runtime
    .normalizeAttachments(params.ctx)
    .map((attachment) =>
      normalizeOptionalString(attachment.path)
        ? Object.assign({}, attachment, { url: undefined })
        : attachment,
    );
  const recentHistoryImages = includeRecentHistoryImages
    ? resolveRecentInboundHistoryImages({ ctx: params.ctx })
    : [];
  const firstHistoryAttachmentIndex =
    currentAttachments.reduce(
      (maxIndex, attachment) =>
        Number.isFinite(attachment.index) ? Math.max(maxIndex, attachment.index) : maxIndex,
      -1,
    ) + 1;
  const historyAttachments: MediaAttachment[] = recentHistoryImages.map((image, index) => ({
    path: image.path,
    mime: image.contentType,
    index: firstHistoryAttachmentIndex + index,
  }));
  const historyAttachmentByIndex = new Map(
    historyAttachments.map((attachment, index) => [attachment.index, recentHistoryImages[index]]),
  );
  const mediaAttachments = [...currentAttachments, ...historyAttachments];
  const cache = new runtime.MediaAttachmentCache(mediaAttachments, {
    localPathRoots: runtime.resolveMediaAttachmentLocalRoots({
      cfg: params.cfg,
      ctx: params.ctx,
    }),
  });
  const results: AgentTurnAttachment[] = [];
  const resultIndexes: number[] = [];
  const resolvedHistoryImages: RecentInboundHistoryImage[] = [];
  const resolveAttachment = async (attachment: MediaAttachment): Promise<boolean> => {
    const mediaType = normalizeAgentTurnMediaType(attachment.mime);
    if (!isSupportedAgentTurnAttachment(attachment, includeAudio)) {
      return false;
    }
    if (!normalizeOptionalString(attachment.path)) {
      return false;
    }
    try {
      const { buffer } = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: AGENT_TURN_ATTACHMENT_MAX_BYTES,
        timeoutMs: AGENT_TURN_ATTACHMENT_TIMEOUT_MS,
      });
      results.push({
        mediaType,
        data: buffer.toString("base64"),
      });
      resultIndexes.push(attachment.index);
      const historyImage = historyAttachmentByIndex.get(attachment.index);
      if (historyImage) {
        resolvedHistoryImages.push(historyImage);
      }
      return true;
    } catch (error) {
      if (runtime.isMediaUnderstandingSkipError(error)) {
        logVerbose(
          `agent-turn-attachments: skipping attachment #${attachment.index + 1} (${error.reason})`,
        );
      } else {
        const errorName = error instanceof Error ? error.name : typeof error;
        logVerbose(
          `agent-turn-attachments: failed to read attachment #${attachment.index + 1} (${errorName})`,
        );
      }
      return false;
    }
  };

  let currentImageResolved = false;
  const hasCurrentMedia = currentAttachments.length > 0;
  const hasCurrentImageCandidate = currentAttachments.some(isImageAgentTurnAttachment);
  for (const attachment of currentAttachments) {
    const resolved = await resolveAttachment(attachment);
    currentImageResolved =
      (resolved && isImageAgentTurnAttachment(attachment)) || currentImageResolved;
  }
  if (
    includeRecentHistoryImages &&
    !currentImageResolved &&
    (!hasCurrentMedia || hasCurrentImageCandidate)
  ) {
    // History images are only used when the current turn did not already provide an image.
    for (const attachment of historyAttachments) {
      await resolveAttachment(attachment);
    }
  }
  return {
    attachments: results,
    ...(params.includeAttachmentIndexes ? { attachmentIndexes: resultIndexes } : {}),
    recentHistoryImages: resolvedHistoryImages,
  };
}

/** Converts inline image content into ACP attachment payloads. */
export function resolveInlineAgentImageAttachments(
  images: Array<{ data: string; mimeType: string }> | undefined,
): AgentTurnAttachment[] {
  if (!Array.isArray(images)) {
    return [];
  }
  return images
    .map((image) => ({
      mediaType: image.mimeType,
      data: image.data,
    }))
    .filter((image) => image.mediaType.startsWith("image/") && image.data.trim().length > 0);
}

import path from "node:path";
import {
  assertNoWindowsNetworkPath,
  safeFileURLToPath,
  trySafeFileURLToPath,
} from "@openclaw/fs-safe/advanced";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isImageMediaFact,
  normalizeMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { resolveUserPath } from "../../../utils.js";

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export type MediaFileRef = {
  raw: string;
  type: "path" | "media-uri";
  resolved: string;
};

export type MediaImageRef = MediaFileRef & {
  aliases: string[];
  detect?: boolean;
  factIndex: number;
  hydrate: boolean;
  workspaceDir?: string;
};

export function isOpenClawCliImageCachePath(filePath: string): boolean {
  const parts = filePath.replaceAll("\\", "/").split("/");
  return parts.some((part, index) => {
    if (part === ".openclaw-cli-images") {
      return true;
    }
    const parent = parts[index - 1] ?? "";
    return part === "openclaw-cli-images" && /^openclaw(?:-\d+)?$/.test(parent);
  });
}

export function resolveMediaFactLocalRef(fact: MediaFact): MediaFileRef | undefined {
  const mediaUri = [fact.url, fact.path].find((value) => value?.startsWith("media://inbound/"));
  const identity = mediaUri ?? fact.path ?? fact.url;
  if (!identity) {
    return undefined;
  }
  let resolved = mediaUri;
  if (!resolved && /^file:/i.test(identity)) {
    resolved = trySafeFileURLToPath(identity);
  } else if (
    !resolved &&
    (!URL_SCHEME_PATTERN.test(identity) || WINDOWS_DRIVE_PATH_PATTERN.test(identity))
  ) {
    resolved = identity;
  }
  if (!resolved) {
    return undefined;
  }
  return {
    raw: identity,
    type: mediaUri ? "media-uri" : "path",
    resolved: resolved.startsWith("~") ? resolveUserPath(resolved) : resolved,
  };
}

export function mediaFactToImageRef(fact: MediaFact, factIndex: number): MediaImageRef | undefined {
  if (!isImageMediaFact(fact)) {
    return undefined;
  }
  const localRef = resolveMediaFactLocalRef(fact);
  const identity = localRef?.raw ?? fact.path ?? fact.url;
  if (!identity && fact.hydrationSuppressed !== true) {
    return undefined;
  }
  const usableRef =
    localRef && !isOpenClawCliImageCachePath(localRef.resolved) ? localRef : undefined;
  return {
    ...(usableRef ?? { raw: identity ?? "", type: "path", resolved: identity ?? "" }),
    aliases: [fact.path, fact.url, usableRef?.resolved].filter((value): value is string =>
      Boolean(value),
    ),
    ...(!usableRef ? { detect: false } : {}),
    factIndex,
    hydrate: Boolean(usableRef) && fact.hydrationSuppressed !== true,
    ...(fact.workspaceDir ? { workspaceDir: fact.workspaceDir } : {}),
  };
}

// Guards for transports that cannot carry attachments (paired-node CLI): only
// facts that will actually hydrate an image count; described/remote-only facts
// whose hydration is suppressed must not block text-only prompts.
export function hasHydratableMediaImages(media?: readonly MediaFact[]): boolean {
  return normalizeMediaFacts(media)
    .map(mediaFactToImageRef)
    .some((ref) => ref?.hydrate === true);
}

const IMAGE_EXTENSION_PATTERN = "png|jpg|jpeg|gif|webp|bmp|tiff|tif|heic|heif";
const FILE_URL_REGEX_SOURCE = "file://[^\\s<>\"'`\\]]+\\.(?:" + IMAGE_EXTENSION_PATTERN + ")";
const WINDOWS_DRIVE_PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])([A-Za-z]:[\\\\/][^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])((\\.\\.?/|[~/])[^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const FILE_URL_PATTERN = new RegExp(FILE_URL_REGEX_SOURCE, "gi");
const PROMPT_WINDOWS_DRIVE_PATH_PATTERN = new RegExp(WINDOWS_DRIVE_PATH_REGEX_SOURCE, "gi");
const PATH_PATTERN = new RegExp(PATH_REGEX_SOURCE, "gi");
const LEGACY_ATTACHMENT_MARKER_PATTERN =
  /\[(?:media attached(?:\s+\d+\/\d+)?:|Image:\s*source:)\s*[^\]]+\]/gi;

function normalizeRefForDedupe(raw: string): string {
  const projected =
    process.platform === "darwin" && raw.startsWith("/private/var/")
      ? raw.slice("/private".length)
      : raw;
  return process.platform === "win32" ? normalizeLowercaseStringOrEmpty(projected) : projected;
}

/** Detects explicit local image paths and file URLs in user prompt text. */
export function detectImageReferences(prompt: string): MediaFileRef[] {
  const refs: MediaFileRef[] = [];
  const seen = new Set<string>();
  const pathPrompt = prompt.replace(LEGACY_ATTACHMENT_MARKER_PATTERN, (marker) =>
    " ".repeat(marker.length),
  );

  const addPathRef = (raw: string, fileUrl: boolean) => {
    const trimmed = raw.trim();
    const dedupeKey = normalizeRefForDedupe(trimmed);
    if (!trimmed || seen.has(dedupeKey)) {
      return;
    }
    // An extension-only basename is a dotfile even though the regex accepts it.
    if (!fileUrl && !path.extname(trimmed)) {
      return;
    }
    let resolved = trimmed;
    try {
      if (fileUrl) {
        resolved = safeFileURLToPath(trimmed);
      } else {
        assertNoWindowsNetworkPath(trimmed, "Image path");
      }
    } catch {
      return;
    }
    if (!fileUrl && trimmed.startsWith("~")) {
      resolved = resolveUserPath(trimmed);
    }
    if (isOpenClawCliImageCachePath(resolved)) {
      return;
    }
    seen.add(dedupeKey);
    refs.push({ raw: trimmed, type: "path", resolved });
  };

  for (const [pattern, group, fileUrl] of [
    [FILE_URL_PATTERN, 0, true],
    [PROMPT_WINDOWS_DRIVE_PATH_PATTERN, 1, false],
    [PATH_PATTERN, 1, false],
  ] as const) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(pathPrompt)) !== null) {
      if (match[group]) {
        addPathRef(match[group], fileUrl);
      }
    }
  }

  return refs;
}

export function refDedupeKey(ref: MediaFileRef, workspaceDir?: string): string {
  const resolved =
    ref.type === "path" && workspaceDir && !path.isAbsolute(ref.resolved)
      ? path.resolve(workspaceDir, ref.resolved)
      : ref.resolved;
  return `${ref.type}\0${normalizeRefForDedupe(resolved)}`;
}

export function rawAliasDedupeKey(alias: string): string | undefined {
  return path.isAbsolute(alias) ||
    /^[A-Za-z]:[\\/]/.test(alias) ||
    /^[a-z][a-z0-9+.-]*:/i.test(alias)
    ? normalizeRefForDedupe(alias)
    : undefined;
}

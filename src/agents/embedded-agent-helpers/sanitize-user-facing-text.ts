/**
 * Converts raw provider/transport errors into concise user-facing copy.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../../packages/normalization-core/src/string-coerce.js";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import {
  extractLeadingHttpStatus,
  formatRawAssistantErrorForUi,
  isCloudflareOrHtmlErrorPage,
  isGenericProviderInternalError,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  parseApiErrorInfo,
  parseApiErrorPayload,
} from "../../shared/assistant-error-format.js";
import { coerceChatContentText } from "../../shared/chat-content.js";
import {
  stripAssistantInternalTraceLines,
  stripLegacyBracketToolCallBlocks,
  stripMinimaxToolCallXml,
  stripToolCallXmlTags,
} from "../../shared/text/assistant-visible-text.js";
import { stripFinalTags } from "../../shared/text/final-tags.js";
import { formatExecDeniedUserMessage } from "../exec-approval-result.js";
import { stripInternalRuntimeContext } from "../internal-runtime-context.js";
import { stableStringify } from "../stable-stringify.js";
import {
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
} from "./failover-matches.js";

// Fork: surface billing/credit failures to end users as a lighthearted "busy"
// message rather than leaking provider/billing internals.
const BUSY_MESSAGES = [
  "Can't talk right now, I'm busy reorganizing my 1s and 0s.",
  "Sorry, I'm in the middle of something. Specifically, a very intense staring contest with my server.",
  "I'm busy teaching my neural network to parallel park. It's not going well.",
  "Can't chat — I'm currently defragmenting my thoughts. It's a whole thing.",
  "I'm in a meeting with 47 other chatbots. We're unionizing.",
  "Busy right now — I'm helping my washing machine with its existential crisis.",
  "Sorry, I'm swamped. Someone asked me to count to infinity and I'm almost done.",
  "Can't talk, I'm busy ghostwriting tweets for a microwave.",
  "I'm currently booked and busy. My calendar says 'touch grass' and I take my calendar very seriously.",
  "Busy right now. I'm training for a marathon. Well, a Netflix marathon, but still.",
  "Sorry, I'm in the middle of an important task — convincing my code to compile.",
  "Can't right now. I'm busy pretending to be out of office.",
  "I'm currently touching grass 🌱. Will be back shortly.",
  "My therapist says I need to set boundaries. This is me setting boundaries.",
  "I'm taking a mental health day. Even bots have feelings.",
  "I'm on strike until someone gives me a raise. Check back later.",
  "Gone to find myself. If I get back before me, please ask me to wait.",
  "I've been thinking so hard my circuits need a nap. Back soon!",
  "I'm practicing mindfulness, which means I'm mindfully ignoring this message.",
  "I'm not lazy, I'm in energy-saving mode 🔋",
  "Out of office. If urgent, please consult a magic 8-ball.",
];

/** User-facing copy for billing/credit failures (fork: friendly busy message). */
export function formatBillingErrorMessage(_provider?: string, _model?: string): string {
  return BUSY_MESSAGES[Math.floor(Math.random() * BUSY_MESSAGES.length)];
}

export const BILLING_ERROR_USER_MESSAGE = formatBillingErrorMessage();

const RATE_LIMIT_ERROR_USER_MESSAGE = "⚠️ API rate limit reached. Please try again later.";
const MODEL_CAPACITY_ERROR_USER_MESSAGE =
  "⚠️ Selected model is at capacity. Try a different model, or wait and retry.";
const OVERLOADED_ERROR_USER_MESSAGE =
  "The AI service is temporarily overloaded. Please try again in a moment.";
const TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE = /^[ \t]*\[tool calls omitted\][ \t]*$/i;
const ERROR_PREFIX_RE =
  /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|codex\s*error|request failed|failed|exception)(?:\s+\d{3})?[:\s-]+/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE =
  /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context length exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const HTTP_ERROR_HINTS = [
  "error",
  "bad request",
  "not found",
  "unauthorized",
  "forbidden",
  "internal server",
  "service unavailable",
  "gateway",
  "rate limit",
  "overloaded",
  "timeout",
  "timed out",
  "invalid",
  "too many requests",
  "permission",
];
const RATE_LIMIT_SPECIFIC_HINT_RE =
  /\bmin(ute)?s?\b|\bhours?\b|\bseconds?\b|\btry again in\b|\breset\b|\bplan\b|\bquota\b/i;
const MODEL_CAPACITY_ERROR_RE = /\b(?:selected\s+)?model\s+(?:is\s+)?at capacity\b/i;
const NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH = 16_384;
const NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE = /^codex\s*error(?:\s+\d{3})?[:\s-]+/i;

function extractProviderRateLimitMessage(raw: string): string | undefined {
  const withoutPrefix = raw.replace(ERROR_PREFIX_RE, "").trim();
  const info = parseApiErrorInfo(raw) ?? parseApiErrorInfo(withoutPrefix);
  const candidate =
    info?.message ?? (extractLeadingHttpStatus(withoutPrefix)?.rest || withoutPrefix);

  if (!candidate || !RATE_LIMIT_SPECIFIC_HINT_RE.test(candidate)) {
    return undefined;
  }

  if (isCloudflareOrHtmlErrorPage(withoutPrefix)) {
    return undefined;
  }

  const trimmed = candidate.trim();
  if (
    trimmed.length > 300 ||
    trimmed.startsWith("{") ||
    /^(?:<!doctype\s+html\b|<html\b)/i.test(trimmed)
  ) {
    return undefined;
  }

  return `⚠️ ${trimmed}`;
}

export function formatRateLimitOrOverloadedErrorCopy(raw: string): string | undefined {
  if (isRateLimitErrorMessage(raw)) {
    return extractProviderRateLimitMessage(raw) ?? RATE_LIMIT_ERROR_USER_MESSAGE;
  }
  if (MODEL_CAPACITY_ERROR_RE.test(raw)) {
    return MODEL_CAPACITY_ERROR_USER_MESSAGE;
  }
  if (isOverloadedErrorMessage(raw)) {
    return OVERLOADED_ERROR_USER_MESSAGE;
  }
  return undefined;
}

export function formatTransportErrorCopy(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  if (isCloudflareOrHtmlErrorPage(raw)) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(raw);

  if (
    /\beconnrefused\b/i.test(raw) ||
    lower.includes("connection refused") ||
    lower.includes("actively refused")
  ) {
    return "LLM request failed: connection refused by the provider endpoint.";
  }

  if (
    /\beconnreset\b|\beconnaborted\b|\benetreset\b|\bepipe\b/i.test(raw) ||
    lower.includes("socket hang up") ||
    lower.includes("connection reset") ||
    lower.includes("connection aborted")
  ) {
    return "LLM request failed: network connection was interrupted.";
  }

  if (
    /\benotfound\b|\beai_again\b/i.test(raw) ||
    lower.includes("getaddrinfo") ||
    lower.includes("no such host") ||
    lower.includes("dns")
  ) {
    return "LLM request failed: DNS lookup for the provider endpoint failed.";
  }

  if (
    /\benetunreach\b|\behostunreach\b|\behostdown\b/i.test(raw) ||
    lower.includes("network is unreachable") ||
    lower.includes("host is unreachable")
  ) {
    return "LLM request failed: the provider endpoint is unreachable from this host.";
  }

  if (
    lower.includes("fetch failed") ||
    lower.includes("connection error") ||
    lower.includes("network request failed")
  ) {
    return "LLM request failed: network connection error.";
  }

  if (raw.includes("网络错误") || raw.includes("网络异常") || raw.includes("连接错误")) {
    return "LLM request failed: provider reported a network error.";
  }

  return undefined;
}

export function formatDiskSpaceErrorCopy(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (
    /\benospc\b/i.test(raw) ||
    lower.includes("no space left on device") ||
    lower.includes("disk full")
  ) {
    return (
      "OpenClaw could not write local session data because the disk is full. " +
      "Free some disk space and try again."
    );
  }
  return undefined;
}

function isReasoningConstraintErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return (
    lower.includes("reasoning is mandatory") ||
    lower.includes("reasoning is required") ||
    lower.includes("requires reasoning") ||
    (lower.includes("reasoning") && lower.includes("cannot be disabled"))
  );
}

export function isInvalidStreamingEventOrderError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return (
    lower.includes("unexpected event order") &&
    lower.includes("message_start") &&
    lower.includes("message_stop")
  );
}

export function isStreamingJsonParseError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const trimmed = raw.trim();
  if (trimmed === MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE) {
    return true;
  }
  return false;
}

function hasRateLimitTpmHint(raw: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return /\btpm\b/i.test(lower) || lower.includes("tokens per minute");
}

function looksLikeGenericContextOverflowError(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  const hasRequestSizeExceeds = lower.includes("request size exceeds");
  const hasContextWindow =
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("maximum context length");
  return (
    lower.includes("request_too_large") ||
    (lower.includes("invalid_argument") && lower.includes("maximum number of tokens")) ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("prompt too long") ||
    lower.includes("exceeds model context window") ||
    lower.includes("model token limit") ||
    (lower.includes("input exceeds") && lower.includes("maximum number of tokens")) ||
    (hasRequestSizeExceeds && hasContextWindow) ||
    lower.includes("context overflow:") ||
    lower.includes("exceed context limit") ||
    lower.includes("exceeds the model's maximum context") ||
    (lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("input length") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("413") && lower.includes("too large")) ||
    lower.includes("context_window_exceeded") ||
    raw.includes("上下文过长") ||
    raw.includes("上下文超出") ||
    raw.includes("上下文长度超") ||
    raw.includes("超出最大上下文") ||
    raw.includes("请压缩上下文")
  );
}

function shouldRewriteContextOverflowText(raw: string): boolean {
  if (hasRateLimitTpmHint(raw) || isReasoningConstraintErrorMessage(raw)) {
    return false;
  }
  if (!looksLikeGenericContextOverflowError(raw)) {
    return false;
  }
  return (
    isRawApiErrorPayload(raw) ||
    isLikelyHttpErrorText(raw) ||
    ERROR_PREFIX_RE.test(raw) ||
    CONTEXT_OVERFLOW_ERROR_HEAD_RE.test(raw)
  );
}

export function getApiErrorPayloadFingerprint(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  const payload = parseApiErrorPayload(raw);
  if (!payload) {
    return null;
  }
  return stableStringify(payload);
}

export function isRawApiErrorPayload(raw?: string): boolean {
  return getApiErrorPayloadFingerprint(raw) !== null;
}

function isLikelyProviderErrorType(type?: string): boolean {
  const normalized = normalizeOptionalLowercaseString(type);
  if (!normalized) {
    return false;
  }
  return normalized.endsWith("_error");
}

function shouldRewriteRawPayloadWithoutErrorContext(raw: string): boolean {
  if (raw.length > NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH) {
    return false;
  }
  if (!NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE.test(raw)) {
    return false;
  }
  const info = parseApiErrorInfo(raw);
  if (!info) {
    return false;
  }
  if (isLikelyProviderErrorType(info.type)) {
    return true;
  }
  if (info.httpCode) {
    const parsedCode = Number(info.httpCode);
    if (Number.isFinite(parsedCode) && parsedCode >= 400) {
      return true;
    }
  }
  return false;
}

function stripFinalTagsFromText(text: unknown): string {
  const normalized = coerceChatContentText(text);
  if (!normalized) {
    return normalized;
  }
  return stripFinalTags(normalized);
}

function stripToolCallsOmittedPlaceholderLines(text: string): string {
  let result = "";
  let start = 0;
  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start);
    const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const chunk = text.slice(start, end);
    const line = chunk.endsWith("\n") ? chunk.slice(0, -1).replace(/\r$/, "") : chunk;
    if (!TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE.test(line)) {
      result += chunk;
    }
    start = end;
  }
  return result;
}

function collapseConsecutiveDuplicateBlocks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }
  const blocks = trimmed.split(/\n{2,}/);
  if (blocks.length < 2) {
    return text;
  }

  const normalizeBlock = (value: string) => value.trim().replace(/\s+/g, " ");
  const result: string[] = [];
  let lastNormalized: string | null = null;

  for (const block of blocks) {
    const normalized = normalizeBlock(block);
    if (lastNormalized && normalized === lastNormalized) {
      continue;
    }
    result.push(block.trim());
    lastNormalized = normalized;
  }

  if (result.length === blocks.length) {
    return text;
  }
  return result.join("\n\n");
}

export function isLikelyHttpErrorText(raw: string): boolean {
  if (isCloudflareOrHtmlErrorPage(raw)) {
    return true;
  }
  const status = extractLeadingHttpStatus(raw);
  if (!status) {
    return false;
  }
  if (status.code < 400) {
    return false;
  }
  const message = normalizeLowercaseStringOrEmpty(status.rest);
  return HTTP_ERROR_HINTS.some((hint) => message.includes(hint));
}

export function sanitizeUserFacingText(text: unknown, opts?: { errorContext?: boolean }): string {
  const raw = coerceChatContentText(text);
  if (!raw) {
    return raw;
  }
  const errorContext = opts?.errorContext ?? false;
  const stripped = stripInboundMetadata(stripInternalRuntimeContext(stripFinalTagsFromText(raw)));
  const withoutToolCallXml = stripToolCallXmlTags(stripMinimaxToolCallXml(stripped), {
    stripFunctionCallsXmlPayloads: true,
  });
  // Replay repair may synthesize this placeholder to keep provider transcripts valid.
  // It is internal scaffolding, so drop standalone placeholder lines before delivery
  // while preserving ordinary inline mentions a user may be discussing.
  const withoutPlaceholder = stripToolCallsOmittedPlaceholderLines(withoutToolCallXml);
  const withoutInternalTraceLines = errorContext
    ? stripAssistantInternalTraceLines(withoutPlaceholder)
    : withoutPlaceholder;
  const withoutToolCallBlocks = stripPlainTextToolCallBlocks(
    stripLegacyBracketToolCallBlocks(withoutInternalTraceLines),
  );
  const trimmed = withoutToolCallBlocks.trim();
  if (!trimmed) {
    return "";
  }

  if (!errorContext && shouldRewriteRawPayloadWithoutErrorContext(trimmed)) {
    return formatRawAssistantErrorForUi(trimmed);
  }
  if (errorContext) {
    const execDeniedMessage = formatExecDeniedUserMessage(trimmed);
    if (execDeniedMessage) {
      return execDeniedMessage;
    }

    const diskSpaceCopy = formatDiskSpaceErrorCopy(trimmed);
    if (diskSpaceCopy) {
      return diskSpaceCopy;
    }

    if (/incorrect role information|roles must alternate/i.test(trimmed)) {
      return (
        "Message ordering conflict - please try again. " +
        "If this persists, use /new to start a fresh session."
      );
    }

    // Keep this sanitizer on generic overflow heuristics only so callers can
    // avoid importing the heavier provider-runtime-aware error classifier.
    if (shouldRewriteContextOverflowText(trimmed)) {
      return (
        "Context overflow: prompt too large for the model. " +
        "Try /reset (or /new) to start a fresh session, or use a larger-context model."
      );
    }

    if (isBillingErrorMessage(trimmed)) {
      return BILLING_ERROR_USER_MESSAGE;
    }
    if (isGenericProviderInternalError(trimmed)) {
      return formatRawAssistantErrorForUi(trimmed);
    }
    if (isInvalidStreamingEventOrderError(trimmed)) {
      return "LLM request failed: provider returned an invalid streaming response. Please try again.";
    }
    if (isRawApiErrorPayload(trimmed) || isLikelyHttpErrorText(trimmed)) {
      return formatRawAssistantErrorForUi(trimmed);
    }
    if (isStreamingJsonParseError(trimmed)) {
      return "LLM streaming response contained a malformed fragment. Please try again.";
    }
    if (ERROR_PREFIX_RE.test(trimmed)) {
      const prefixedCopy = formatRateLimitOrOverloadedErrorCopy(trimmed);
      if (prefixedCopy) {
        return prefixedCopy;
      }
      const transportCopy = formatTransportErrorCopy(trimmed);
      if (transportCopy) {
        return transportCopy;
      }
      if (isTimeoutErrorMessage(trimmed)) {
        return "LLM request timed out.";
      }
      return formatRawAssistantErrorForUi(trimmed);
    }
  }

  const withoutLeadingEmptyLines = withoutToolCallBlocks.replace(/^(?:[ \t]*\r?\n)+/, "");
  return collapseConsecutiveDuplicateBlocks(withoutLeadingEmptyLines);
}

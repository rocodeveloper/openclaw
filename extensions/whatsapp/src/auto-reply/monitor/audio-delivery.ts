// Whatsapp plugin module: resolves how inbound voice notes are delivered to the
// agent (native inline audio vs. transcription preflight), from
// `tools.media.audio.delivery`.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type AudioDeliveryMode = "auto" | "native" | "transcript";

/**
 * Resolves the configured audio delivery mode. Defaults to "auto" when unset.
 *
 * - "transcript": only the transcription preflight runs (current behavior).
 * - "native": attach raw audio to audio-capable models; skip the preflight.
 * - "auto": attach native audio for audio-capable models AND keep the preflight
 *   transcription as a safe fallback for non-audio models.
 */
export function resolveAudioDeliveryMode(cfg: OpenClawConfig): AudioDeliveryMode {
  const mode = cfg.tools?.media?.audio?.delivery;
  if (mode === "native" || mode === "transcript" || mode === "auto") {
    return mode;
  }
  return "auto";
}

/** True when native inline audio should be attached for audio-capable models. */
export function shouldAttachNativeAudio(mode: AudioDeliveryMode): boolean {
  return mode === "native" || mode === "auto";
}

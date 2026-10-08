import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/types.js";

export type AudioDeliveryMode = "auto" | "native" | "transcript";

export type PreTurnAudioPlan = "transcribe" | "prime" | "defer";

const MAX_REMEMBERED_AUDIO_TRANSCRIPTS = 256;
const audioTranscripts = new Map<string, Promise<string | undefined>>();

export function resolveAudioDeliveryMode(cfg: OpenClawConfig | undefined): AudioDeliveryMode {
  return cfg?.tools?.media?.audio?.delivery ?? "auto";
}

export function deliversNativeAudio(
  mode: AudioDeliveryMode,
  modelInput: readonly string[] | undefined,
): boolean {
  return mode !== "transcript" && (modelInput?.includes("audio") ?? false);
}

export function planPreTurnAudioTranscription(params: {
  mode: AudioDeliveryMode;
  selectedAcceptsAudio: boolean;
  fallbacksAcceptAudio: readonly boolean[];
}): PreTurnAudioPlan {
  if (params.mode === "transcript" || !params.selectedAcceptsAudio) {
    return "transcribe";
  }
  if (params.mode === "auto" && params.fallbacksAcceptAudio.some((accepts) => !accepts)) {
    return "prime";
  }
  return "defer";
}

export function audioTranscriptKey(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function transcribeAudioOnce(
  key: string,
  transcribe: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const remembered = audioTranscripts.get(key);
  if (remembered) {
    return remembered;
  }
  const pending = transcribe().then(
    (transcript) => transcript?.trim() || undefined,
    () => undefined,
  );
  audioTranscripts.set(key, pending);
  const oldestKey = audioTranscripts.keys().next().value;
  if (audioTranscripts.size > MAX_REMEMBERED_AUDIO_TRANSCRIPTS && oldestKey !== undefined) {
    audioTranscripts.delete(oldestKey);
  }
  return pending;
}

export function clearRememberedAudioTranscripts(): void {
  audioTranscripts.clear();
}

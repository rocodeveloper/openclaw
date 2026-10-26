import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingCapabilityConfig } from "../config/types.tools.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";

export type AudioDeliveryMode = NonNullable<MediaUnderstandingCapabilityConfig["delivery"]>;

export type PreTurnAudioPlan = "transcribe" | "prime" | "defer";

const MAX_REMEMBERED_AUDIO_TRANSCRIPTS = 256;
export type MediaExecutionGuards = {
  signal?: AbortSignal;
  assertCurrent?: () => void;
};

export type ScheduleAudioPrime = (run: (guards: MediaExecutionGuards) => Promise<void>) => void;

type AudioTranscriptEntry = {
  result: Promise<string | undefined>;
  producer?: MediaExecutionGuards;
};

const audioTranscripts = new Map<string, AudioTranscriptEntry>();

export function assertMediaExecutionCurrent(guards: MediaExecutionGuards): void {
  guards.signal?.throwIfAborted();
  guards.assertCurrent?.();
}

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

export function audioTranscriptKey(
  bytes: Uint8Array,
  scope?: readonly (string | undefined)[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(scope ?? []))
    .update(bytes)
    .digest("hex");
}

export async function transcribeAudioOnce(
  key: string,
  transcribe: () => Promise<string | undefined>,
  guards: MediaExecutionGuards = {},
): Promise<string | undefined> {
  assertMediaExecutionCurrent(guards);
  let remembered = audioTranscripts.get(key);
  if (remembered?.producer) {
    try {
      assertMediaExecutionCurrent(remembered.producer);
    } catch {
      audioTranscripts.delete(key);
      remembered = undefined;
    }
  }
  if (!remembered) {
    const entry: AudioTranscriptEntry = {
      result: Promise.resolve(undefined),
      producer: guards,
    };
    const retire = () => {
      if (audioTranscripts.get(key) === entry) {
        audioTranscripts.delete(key);
      }
    };
    guards.signal?.addEventListener("abort", retire, { once: true });
    entry.result = Promise.resolve()
      .then(() => {
        assertMediaExecutionCurrent(guards);
        return transcribe();
      })
      .then(
        (transcript) => {
          assertMediaExecutionCurrent(guards);
          return transcript?.trim() || undefined;
        },
        () => {
          assertMediaExecutionCurrent(guards);
          return undefined;
        },
      )
      .then(
        (result) => {
          entry.producer = undefined;
          guards.signal?.removeEventListener("abort", retire);
          return result;
        },
        (error: unknown) => {
          retire();
          guards.signal?.removeEventListener("abort", retire);
          throw error;
        },
      );
    audioTranscripts.set(key, entry);
    const oldestKey = audioTranscripts.keys().next().value;
    if (audioTranscripts.size > MAX_REMEMBERED_AUDIO_TRANSCRIPTS && oldestKey !== undefined) {
      audioTranscripts.delete(oldestKey);
    }
    remembered = entry;
  }
  const result = await racePromiseWithAbortSignal(remembered.result, guards.signal);
  assertMediaExecutionCurrent(guards);
  return result;
}

export function clearRememberedAudioTranscripts(): void {
  audioTranscripts.clear();
}

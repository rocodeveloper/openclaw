import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  deliversNativeAudio,
  resolveAudioDeliveryMode,
} from "../../../media-understanding/audio-delivery.js";
import type { AgentMessage } from "../../runtime/index.js";
import { appendProviderAudioTranscripts, type ProviderAudioDelivery } from "./images.js";

type AudioTranscriptOptions = Omit<
  Parameters<typeof appendProviderAudioTranscripts>[1],
  "transcribe" | "signal"
>;

export type AttemptAudioDelivery =
  | { kind: "transcript-only" }
  | { kind: "native"; audio: ProviderAudioDelivery }
  | { kind: "provider-transcript"; transcribe: ProviderAudioDelivery["transcribe"] };

export function resolveAttemptAudioDelivery(params: {
  cfg: OpenClawConfig | undefined;
  modelInput: readonly string[] | undefined;
  agentDir?: string;
  workspaceDir?: string;
}): AttemptAudioDelivery {
  const mode = resolveAudioDeliveryMode(params.cfg);
  if (mode === "transcript") {
    return { kind: "transcript-only" };
  }
  const transcribe: ProviderAudioDelivery["transcribe"] = async (fact, bytes) => {
    const { transcribeProviderAudioFact } =
      await import("../../../media-understanding/provider-audio-transcript.js");
    return await transcribeProviderAudioFact({
      fact,
      bytes,
      cfg: params.cfg ?? {},
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    });
  };
  return deliversNativeAudio(mode, params.modelInput)
    ? { kind: "native", audio: { native: true, transcribe } }
    : { kind: "provider-transcript", transcribe };
}

export function wrapStreamFnWithProviderAudioTranscripts(
  streamFn: StreamFn,
  transcribe: ProviderAudioDelivery["transcribe"],
  options: AudioTranscriptOptions,
): StreamFn {
  return async (model, context, streamOptions) => {
    const messages = context?.messages;
    if (!Array.isArray(messages)) {
      return await streamFn(model, context, streamOptions);
    }
    const nextMessages = await appendProviderAudioTranscripts(messages as AgentMessage[], {
      ...options,
      transcribe,
      signal: streamOptions?.signal,
    });
    return await streamFn(
      model,
      nextMessages === messages
        ? context
        : { ...context, messages: nextMessages as typeof context.messages },
      streamOptions,
    );
  };
}

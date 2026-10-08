import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  planPreTurnAudioTranscription,
  resolveAudioDeliveryMode,
  type PreTurnAudioPlan,
} from "../media-understanding/audio-delivery.js";
import { parseModelRef } from "./model-selection-normalize.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";

type ResolveModelAsync = (typeof import("./embedded-agent-runner/model.js"))["resolveModelAsync"];

type ModelAudioLookup = {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  deps?: { resolveModelAsync?: ResolveModelAsync };
};

const resolveModelAsyncDefault: ResolveModelAsync = async (...args) => {
  const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
  return await resolveModelAsync(...args);
};

async function resolveModelAcceptsAudio(
  params: ModelAudioLookup & { provider: string; model: string },
): Promise<boolean> {
  const resolveModelAsync = params.deps?.resolveModelAsync ?? resolveModelAsyncDefault;
  try {
    const resolved = await resolveModelAsync(
      params.provider,
      params.model,
      params.agentDir,
      params.cfg,
      {
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      },
    );
    return ((resolved.model?.input ?? []) as readonly string[]).includes("audio");
  } catch {
    return false;
  }
}

export async function resolvePreTurnAudioPlan(
  params: ModelAudioLookup & { activeModel?: { provider?: string; model?: string } },
): Promise<PreTurnAudioPlan> {
  const mode = resolveAudioDeliveryMode(params.cfg);
  const provider = params.activeModel?.provider?.trim();
  const model = params.activeModel?.model?.trim();
  if (mode === "transcript" || !provider || !model) {
    return "transcribe";
  }
  const selectedAcceptsAudio = await resolveModelAcceptsAudio({ ...params, provider, model });
  if (!selectedAcceptsAudio || mode === "native") {
    return planPreTurnAudioTranscription({ mode, selectedAcceptsAudio, fallbacksAcceptAudio: [] });
  }
  const fallbackRefs = resolveConfiguredModelFallbacks({
    cfg: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  }).flatMap((raw) => parseModelRef(raw, provider) ?? []);
  const fallbacksAcceptAudio = await Promise.all(
    fallbackRefs.map((ref) =>
      resolveModelAcceptsAudio({ ...params, provider: ref.provider, model: ref.model }),
    ),
  );
  return planPreTurnAudioTranscription({ mode, selectedAcceptsAudio, fallbacksAcceptAudio });
}

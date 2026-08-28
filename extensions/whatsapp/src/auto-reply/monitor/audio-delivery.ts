import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type AudioDeliveryMode = "auto" | "native" | "transcript";
export type AudioDelivery = "native" | "transcript";

export function resolveAudioDeliveryMode(cfg: OpenClawConfig): AudioDeliveryMode {
  const mode = cfg.tools?.media?.audio?.delivery;
  if (mode === "native" || mode === "transcript" || mode === "auto") {
    return mode;
  }
  return "auto";
}

export function resolveAudioDelivery(params: {
  mode: AudioDeliveryMode;
  supportsAudio: boolean;
}): AudioDelivery {
  if (params.mode === "transcript") {
    return "transcript";
  }
  return params.supportsAudio ? "native" : "transcript";
}

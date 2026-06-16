import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type AudioDeliveryMode = "auto" | "native" | "transcript";

export function resolveAudioDeliveryMode(cfg: OpenClawConfig): AudioDeliveryMode {
  const mode = cfg.tools?.media?.audio?.delivery;
  if (mode === "native" || mode === "transcript" || mode === "auto") {
    return mode;
  }
  return "auto";
}

export function shouldAttachNativeAudio(mode: AudioDeliveryMode): boolean {
  return mode === "native" || mode === "auto";
}

import { describe, expect, it } from "vitest";
import { resolveAudioDelivery } from "./audio-delivery.js";

describe("resolveAudioDelivery", () => {
  it.each([
    ["transcript", true, "transcript"],
    ["transcript", false, "transcript"],
    ["native", true, "native"],
    ["native", false, "transcript"],
    ["auto", true, "native"],
    ["auto", false, "transcript"],
  ] as const)("resolves %s mode with audio support=%s to %s", (mode, supportsAudio, expected) => {
    expect(resolveAudioDelivery({ mode, supportsAudio })).toBe(expected);
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolvePreTurnAudioPlan } from "./model-audio-input.js";

const AUDIO_MODELS = new Set(["google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite"]);

function stubResolveModelAsync() {
  return vi.fn(async (provider: string, model: string) => ({
    model: {
      input: AUDIO_MODELS.has(`${provider}/${model}`) ? ["text", "image", "audio"] : ["text"],
    },
  })) as never;
}

function config(delivery: "auto" | "native" | "transcript", fallbacks: string[]) {
  return {
    tools: { media: { audio: { delivery } } },
    agents: {
      list: [{ id: "customer", model: { primary: "google/gemini-3.5-flash-lite", fallbacks } }],
    },
  } as never;
}

describe("resolvePreTurnAudioPlan", () => {
  it.each([
    ["auto", ["google/gemini-3.1-flash-lite"], "defer"],
    ["auto", ["google/gemini-3.1-flash-lite", "openai/gpt-5.4"], "prime"],
    ["native", ["openai/gpt-5.4"], "defer"],
    ["transcript", ["google/gemini-3.1-flash-lite"], "transcribe"],
  ] as const)(
    "plans %s delivery with fallbacks %j as %s",
    async (delivery, fallbacks, expected) => {
      const resolveModelAsync = stubResolveModelAsync();

      await expect(
        resolvePreTurnAudioPlan({
          cfg: config(delivery, [...fallbacks]),
          agentId: "customer",
          activeModel: { provider: "google", model: "gemini-3.5-flash-lite" },
          deps: { resolveModelAsync },
        }),
      ).resolves.toBe(expected);
    },
  );

  it("transcribes before the turn when the selected model cannot take audio", async () => {
    await expect(
      resolvePreTurnAudioPlan({
        cfg: config("native", []),
        agentId: "customer",
        activeModel: { provider: "openai", model: "gpt-5.4" },
        deps: { resolveModelAsync: stubResolveModelAsync() },
      }),
    ).resolves.toBe("transcribe");
  });
});

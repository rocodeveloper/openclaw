import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";

const audioPlan = vi.hoisted(() => ({ current: "transcribe" as "transcribe" | "prime" | "defer" }));
const resolvePreTurnAudioPlan = vi.hoisted(() => vi.fn(async () => audioPlan.current));
const primeAudioTranscript = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../agents/model-audio-input.js", () => ({ resolvePreTurnAudioPlan }));
vi.mock("./provider-audio-transcript.js", () => ({ primeAudioTranscript }));
vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});
vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

const cfg = {
  models: { providers: { openai: { apiKey: "test-key", models: [] } } },
} as unknown as OpenClawConfig;

async function runAudio(activeModel?: { provider: string; model: string }) {
  const transcribeAudio = vi.fn(async () => ({ text: "spoken words", model: "whisper-1" }));
  let result: Awaited<ReturnType<typeof runCapability>> | undefined;
  let mediaPath = "";
  await withAudioFixture("openclaw-native-audio", async ({ ctx, media, cache, mediaPath: p }) => {
    mediaPath = p;
    result = await runCapability({
      capability: "audio",
      cfg,
      ctx,
      attachments: cache,
      media,
      agentId: "customer",
      providerRegistry: new Map([
        ["openai", { id: "openai", capabilities: ["audio"], transcribeAudio }],
      ]),
      ...(activeModel ? { activeModel } : {}),
    });
  });
  return { result: result!, transcribeAudio, mediaPath };
}

describe("runCapability native audio handoff", () => {
  beforeEach(() => {
    resolvePreTurnAudioPlan.mockClear();
    primeAudioTranscript.mockClear();
  });

  it("hands audio to an audio-capable selected model without transcribing", async () => {
    audioPlan.current = "defer";

    const { result, transcribeAudio } = await runAudio({
      provider: "google",
      model: "gemini-3.5-flash-lite",
    });

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(primeAudioTranscript).not.toHaveBeenCalled();
    expect(result.outputs).toEqual([]);
    expect(result.decision.outcome).toBe("skipped");
    expect(result.decision.attachmentDispositions).toEqual({
      0: { kind: "handed-to-native-audio" },
    });
  });

  it("primes one transcript for a non-audio fallback while the turn keeps raw audio", async () => {
    audioPlan.current = "prime";

    const { result, transcribeAudio, mediaPath } = await runAudio({
      provider: "google",
      model: "gemini-3.5-flash-lite",
    });

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(result.outputs).toEqual([]);
    expect(primeAudioTranscript).toHaveBeenCalledTimes(1);
    expect(primeAudioTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ path: mediaPath, cfg }),
    );
  });

  it("transcribes before the turn when the plan needs a transcript", async () => {
    audioPlan.current = "transcribe";

    const { result, transcribeAudio } = await runAudio({ provider: "openai", model: "gpt-5.4" });

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(result.outputs[0]?.text).toBe("spoken words");
  });

  it("keeps preflight transcription without a selected model", async () => {
    audioPlan.current = "defer";

    const { transcribeAudio } = await runAudio();

    expect(resolvePreTurnAudioPlan).not.toHaveBeenCalled();
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });
});

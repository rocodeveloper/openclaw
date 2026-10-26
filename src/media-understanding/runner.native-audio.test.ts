import { createServer } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createMediaAttachmentCache, normalizeMediaAttachments, runCapability } from "./runner.js";
import { createSafeAudioFixtureBuffer, withAudioFixture } from "./runner.test-utils.js";

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

async function runAudio(
  activeModel?: { provider: string; model: string },
  config?: NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>["audio"],
  guards: { signal?: AbortSignal } = {},
) {
  const transcribeAudio = vi.fn(async () => ({ text: "spoken words", model: "whisper-1" }));
  let result: Awaited<ReturnType<typeof runCapability>> | undefined;
  let mediaPath = "";
  await withAudioFixture("openclaw-native-audio", async ({ ctx, media, cache, mediaPath: p }) => {
    mediaPath = p;
    result = await runCapability({
      ...guards,
      scheduleAudioPrime: (run) => {
        void run(guards);
      },
      capability: "audio",
      cfg,
      config,
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
    let finishPrime!: () => void;
    primeAudioTranscript.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPrime = resolve;
        }),
    );

    const { result, transcribeAudio, mediaPath } = await runAudio({
      provider: "google",
      model: "gemini-3.5-flash-lite",
    });

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(result.outputs).toEqual([]);
    expect(primeAudioTranscript).toHaveBeenCalledTimes(1);
    expect(primeAudioTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ fact: expect.objectContaining({ path: mediaPath }), cfg }),
    );
    finishPrime();
  });

  it.each([
    [{ enabled: false }, "disabled", "capability-disabled"],
    [{ scope: { default: "deny" } }, "scope-deny", "scope-denied"],
  ] as const)(
    "keeps media admission before native handoff for %j",
    async (config, outcome, disposition) => {
      audioPlan.current = "prime";
      const { result, transcribeAudio } = await runAudio(
        { provider: "google", model: "gemini-3.5-flash-lite" },
        config,
      );
      expect(resolvePreTurnAudioPlan).not.toHaveBeenCalled();
      expect(primeAudioTranscript).not.toHaveBeenCalled();
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(result.outputs).toEqual([]);
      expect(result.decision.outcome).toBe(outcome);
      expect(result.decision.attachmentDispositions).toEqual({ 0: { kind: disposition } });
    },
  );

  it("transcribes selected URL audio while deferring local audio without resetting the attachment cap", async () => {
    audioPlan.current = "defer";
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "Content-Type": "audio/wav" });
      response.end(createSafeAudioFixtureBuffer());
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("fixture address unavailable");
      }
      await withAudioFixture("openclaw-mixed-audio", async ({ ctx }) => {
        const mediaCtx = {
          media: [
            ...ctx.media,
            { url: `http://127.0.0.1:${address.port}/selected.wav`, contentType: "audio/wav" },
            { url: `http://127.0.0.1:${address.port}/dropped.wav`, contentType: "audio/wav" },
          ],
        };
        const media = normalizeMediaAttachments(mediaCtx);
        const attachments = createMediaAttachmentCache(media, {
          ssrfPolicy: { allowPrivateNetwork: true },
        });
        try {
          const result = await runCapability({
            capability: "audio",
            ctx: mediaCtx,
            media,
            attachments,
            cfg: {
              plugins: { enabled: false },
              tools: {
                media: {
                  models: [
                    {
                      type: "cli",
                      command: process.execPath,
                      args: ["-e", 'process.stdout.write("remote words")'],
                      capabilities: ["audio"],
                    },
                  ],
                },
              },
            },
            config: { attachments: { mode: "all", maxAttachments: 2 } },
            providerRegistry: new Map(),
            activeModel: { provider: "google", model: "gemini-3.5-flash-lite" },
          });
          expect(result.outputs).toEqual([
            expect.objectContaining({ attachmentIndex: 1, text: "remote words" }),
          ]);
          expect(result.decision.attachmentDispositions).toEqual({
            0: { kind: "handed-to-native-audio" },
            1: { kind: "handled" },
            2: { kind: "not-selected" },
          });
          expect(requests).toBe(1);
        } finally {
          await attachments.cleanup();
        }
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects cancellation during model discovery before starting transcription", async () => {
    const discovery = Promise.withResolvers<"transcribe">();
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    resolvePreTurnAudioPlan.mockImplementationOnce(() => {
      entered.resolve();
      return discovery.promise;
    });
    const result = runAudio({ provider: "google", model: "gemini-3.5-flash-lite" }, undefined, {
      signal: controller.signal,
    });
    const outcome = result.then(
      () => "accepted",
      () => "cancelled",
    );
    await entered.promise;
    controller.abort();
    discovery.resolve("transcribe");
    await expect(outcome).resolves.toBe("cancelled");
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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioTranscriptKey,
  clearRememberedAudioTranscripts,
  deliversNativeAudio,
  planPreTurnAudioTranscription,
  resolveAudioDeliveryMode,
  transcribeAudioOnce,
} from "./audio-delivery.js";

describe("audio delivery", () => {
  afterEach(() => {
    clearRememberedAudioTranscripts();
  });

  it("defaults to auto delivery", () => {
    expect(resolveAudioDeliveryMode({})).toBe("auto");
    expect(resolveAudioDeliveryMode({ tools: { media: { audio: { delivery: "native" } } } })).toBe(
      "native",
    );
  });

  it.each([
    ["auto", ["text", "audio"], true],
    ["native", ["text", "audio"], true],
    ["transcript", ["text", "audio"], false],
    ["auto", ["text", "image"], false],
  ] as const)("delivers native audio in %s mode for input %j: %s", (mode, input, expected) => {
    expect(deliversNativeAudio(mode, input)).toBe(expected);
  });

  it.each([
    ["transcript", true, [true], "transcribe"],
    ["auto", false, [true], "transcribe"],
    ["native", false, [true], "transcribe"],
    ["auto", true, [true, true], "defer"],
    ["auto", true, [true, false], "prime"],
    ["native", true, [false], "defer"],
  ] as const)(
    "plans %s mode with selected audio=%s and fallbacks %j as %s",
    (mode, selectedAcceptsAudio, fallbacksAcceptAudio, expected) => {
      expect(
        planPreTurnAudioTranscription({ mode, selectedAcceptsAudio, fallbacksAcceptAudio }),
      ).toBe(expected);
    },
  );

  it("runs one transcription per message key, including after a failure", async () => {
    const transcribe = vi.fn(async () => " spoken words ");
    const failing = vi.fn(async () => {
      throw new Error("stt down");
    });

    await expect(transcribeAudioOnce("voice-a", transcribe)).resolves.toBe("spoken words");
    await expect(transcribeAudioOnce("voice-a", transcribe)).resolves.toBe("spoken words");
    await expect(transcribeAudioOnce("voice-b", failing)).resolves.toBeUndefined();
    await expect(transcribeAudioOnce("voice-b", failing)).resolves.toBeUndefined();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
  });
  it("isolates identical audio by agent, account, session and admitted message", async () => {
    const bytes = Buffer.from("same voice note");
    const scope = ["agent-a", "account-a", "session-a", "message-a"];
    const transcribe = vi.fn(async () => "spoken words");
    await Promise.all([
      transcribeAudioOnce(audioTranscriptKey(bytes, scope), transcribe),
      transcribeAudioOnce(audioTranscriptKey(bytes, scope), transcribe),
    ]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    for (const index of [0, 1, 2, 3]) {
      const other = scope.map((value, position) => (position === index ? `${value}-other` : value));
      await transcribeAudioOnce(audioTranscriptKey(bytes, other), transcribe);
    }
    expect(transcribe).toHaveBeenCalledTimes(5);
    const empty = vi.fn(async () => "  ");
    await transcribeAudioOnce(audioTranscriptKey(Buffer.from("empty"), scope), empty);
    await transcribeAudioOnce(audioTranscriptKey(Buffer.from("empty"), scope), empty);
    expect(empty).toHaveBeenCalledTimes(1);
  });
});

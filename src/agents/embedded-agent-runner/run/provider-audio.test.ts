import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioTranscriptKey,
  clearRememberedAudioTranscripts,
  transcribeAudioOnce,
} from "../../../media-understanding/audio-delivery.js";
import { attachRuntimePromptMediaFacts, type MediaFact } from "../../../media/media-facts.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { StreamFn } from "../../runtime/index.js";
import { materializeProviderContext } from "./images.js";
import {
  resolveAttemptAudioDelivery,
  wrapStreamFnWithProviderAudioTranscripts,
} from "./provider-audio.js";

const OGG = Buffer.concat([
  Buffer.from("OggS", "ascii"),
  Buffer.from([0, 2]),
  Buffer.alloc(20),
  Buffer.from([1, 19]),
  Buffer.from("OpusHead", "ascii"),
  Buffer.from([1, 1, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]),
]);

async function setupVoiceNote(tempDirs: string[]) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-audio-"));
  tempDirs.push(stateDir);
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  const inbound = path.join(stateDir, "media", "inbound");
  await fs.mkdir(inbound, { recursive: true });
  await fs.writeFile(path.join(inbound, "voice.ogg"), OGG);
  return { stateDir, env };
}

function voiceTurn(fact: Partial<MediaFact> = {}) {
  return attachRuntimePromptMediaFacts(
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "[media attached: voice.ogg (audio/ogg)]" }],
      timestamp: 1,
    },
    [
      {
        kind: "audio",
        contentType: "audio/ogg",
        sizeBytes: OGG.length,
        url: "media://inbound/voice.ogg",
        ...fact,
      },
    ],
  );
}

function captureStream() {
  const seen: unknown[][] = [];
  const streamFn: StreamFn = (_model, context) => {
    seen.push(context.messages.map((message) => message.content));
    return createAssistantMessageEventStream();
  };
  return { seen, streamFn };
}

const TEXT_MODEL = { input: ["text", "image"] } as never;

describe("provider audio delivery", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    clearRememberedAudioTranscripts();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it.each([
    ["transcript", ["text", "image", "audio"], "transcript-only"],
    ["auto", ["text", "image", "audio"], "native"],
    ["native", ["text", "image", "audio"], "native"],
    ["auto", ["text", "image"], "provider-transcript"],
    ["native", ["text", "image"], "provider-transcript"],
  ] as const)("resolves %s delivery for input %j as %s", (delivery, modelInput, kind) => {
    expect(
      resolveAttemptAudioDelivery({
        cfg: { tools: { media: { audio: { delivery } } } },
        modelInput,
      }).kind,
    ).toBe(kind);
  });

  it("sends raw audio as provider content to an audio-capable model", async () => {
    const { stateDir, env } = await setupVoiceNote(tempDirs);
    const transcribe = vi.fn(async () => "spoken words");
    try {
      const prepared = await materializeProviderContext({
        context: { systemPrompt: "system", messages: [voiceTurn()], tools: [] },
        workspaceDir: stateDir,
        audio: { native: true, transcribe },
      });

      expect(prepared.messages[0]?.content).toEqual([
        { type: "text", text: "[media attached: voice.ogg (audio/ogg)]" },
        { type: "audio", data: OGG.toString("base64"), mimeType: "audio/ogg" },
      ]);
      expect(transcribe).not.toHaveBeenCalled();
    } finally {
      env.restore();
    }
  });

  it("gives a model without audio input the transcript and no audio bytes", async () => {
    const { stateDir, env } = await setupVoiceNote(tempDirs);
    const transcribe = vi.fn(async () => "spoken words");
    const { seen, streamFn } = captureStream();
    try {
      await wrapStreamFnWithProviderAudioTranscripts(streamFn, transcribe, {
        workspaceDir: stateDir,
      })(TEXT_MODEL, { systemPrompt: "system", messages: [voiceTurn()], tools: [] });

      expect(seen).toEqual([
        [
          [
            { type: "text", text: "[media attached: voice.ogg (audio/ogg)]" },
            { type: "text", text: "[Audio transcript]\nspoken words" },
          ],
        ],
      ]);
    } finally {
      env.restore();
    }
  });

  it("does not add a second transcript for audio already transcribed before the turn", async () => {
    const { stateDir, env } = await setupVoiceNote(tempDirs);
    const transcribe = vi.fn(async () => "spoken words");
    const { seen, streamFn } = captureStream();
    try {
      await wrapStreamFnWithProviderAudioTranscripts(streamFn, transcribe, {
        workspaceDir: stateDir,
      })(TEXT_MODEL, {
        systemPrompt: "system",
        messages: [voiceTurn({ transcribed: true })],
        tools: [],
      });

      expect(transcribe).not.toHaveBeenCalled();
      expect(seen[0]).toEqual([
        [{ type: "text", text: "[media attached: voice.ogg (audio/ogg)]" }],
      ]);
    } finally {
      env.restore();
    }
  });

  it("falls back from an audio model to non-audio models in one turn with one transcript", async () => {
    const { stateDir, env } = await setupVoiceNote(tempDirs);
    const stt = vi.fn(async () => "spoken words");
    const transcribe = (_fact: MediaFact, bytes: Buffer) =>
      transcribeAudioOnce(audioTranscriptKey(bytes), stt);
    const { seen, streamFn } = captureStream();
    const messages = [voiceTurn()];
    try {
      const nativeCall = await materializeProviderContext({
        context: { systemPrompt: "system", messages, tools: [] },
        workspaceDir: stateDir,
        audio: { native: true, transcribe },
      });
      const fallbackStream = wrapStreamFnWithProviderAudioTranscripts(streamFn, transcribe, {
        workspaceDir: stateDir,
      });
      await fallbackStream(TEXT_MODEL, { systemPrompt: "system", messages, tools: [] });
      await fallbackStream(TEXT_MODEL, { systemPrompt: "system", messages, tools: [] });

      expect(nativeCall.messages[0]?.content).toContainEqual(
        expect.objectContaining({ type: "audio" }),
      );
      expect(seen).toHaveLength(2);
      for (const call of seen) {
        expect(call[0]).toContainEqual({ type: "text", text: "[Audio transcript]\nspoken words" });
        expect(JSON.stringify(call)).not.toContain(OGG.toString("base64"));
      }
      expect(stt).toHaveBeenCalledTimes(1);
    } finally {
      env.restore();
    }
  });
});

import type { OpenClawConfig } from "../config/types.js";
import type { MediaFact } from "../media/media-facts.js";
import { audioTranscriptKey, transcribeAudioOnce } from "./audio-delivery.js";

export async function transcribeProviderAudioFact(params: {
  fact: MediaFact;
  bytes: Uint8Array;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<string | undefined> {
  return await transcribeAudioOnce(audioTranscriptKey(params.bytes), async () => {
    const { runAudioTranscription } = await import("./audio-transcription-runner.js");
    const workspaceDir = params.fact.workspaceDir ?? params.workspaceDir;
    const { transcript } = await runAudioTranscription({
      ctx: {
        media: [{ ...params.fact, kind: "audio", transcribed: false }],
      },
      cfg: params.cfg,
      agentDir: params.agentDir,
      ...(workspaceDir ? { localPathRoots: [workspaceDir] } : {}),
    });
    return transcript;
  });
}

export async function primeAudioTranscript(params: {
  path: string;
  contentType?: string;
  workspaceDir?: string;
  cfg: OpenClawConfig;
  agentDir?: string;
}): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(params.path);
  await transcribeProviderAudioFact({
    fact: {
      path: params.path,
      ...(params.contentType ? { contentType: params.contentType } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    },
    bytes,
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
}

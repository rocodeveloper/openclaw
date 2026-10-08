import type {
  Api,
  AssistantMessage,
  ModelInputContent,
  ProviderMessage,
  ProviderModel,
} from "./provider-types.js";
import { transformMessages } from "./transcript-transform.js";
import type { Message, Model as CanonicalModel } from "./types.js";

const IMAGE_OMISSION = "(image omitted: model does not support images)";
const VIDEO_OMISSION = "(video omitted: provider does not support video input)";
const AUDIO_OMISSION = "(audio omitted: provider does not support audio input)";
const MEDIA_OMISSION = {
  image: IMAGE_OMISSION,
  video: VIDEO_OMISSION,
  audio: AUDIO_OMISSION,
} as const;

function projectUserMediaForTransport(
  content: ModelInputContent[],
  supportsImages: boolean,
  supportsVideo: boolean,
  supportsAudio: boolean,
): ModelInputContent[] {
  const result: ModelInputContent[] = [];
  for (const block of content) {
    const supported =
      block.type === "text" ||
      (block.type === "image" && supportsImages) ||
      (block.type === "video" && supportsVideo) ||
      (block.type === "audio" && supportsAudio);
    if (supported) {
      result.push(block);
      continue;
    }
    const text = MEDIA_OMISSION[block.type];
    const previous = result.at(-1);
    if (block.data.trim() && !(previous?.type === "text" && previous.text === text)) {
      result.push({ type: "text", text });
    }
  }
  return result;
}

export function transformProviderMessages<TApi extends Api>(
  messages: ProviderMessage[],
  model: ProviderModel<TApi>,
  normalizeToolCallId?: (
    id: string,
    model: CanonicalModel<TApi>,
    source: AssistantMessage,
  ) => string,
): Message[] {
  const target: CanonicalModel<TApi> = {
    ...model,
    input: model.input.filter(
      (type): type is "text" | "image" => type === "text" || type === "image",
    ),
  };
  return transformMessages(
    messages.map((message): Message => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return message as Message;
      }
      return Object.assign({}, message, {
        content: projectUserMediaForTransport(
          message.content,
          model.input.includes("image"),
          model.api === "openai-completions" && model.input.includes("video"),
          model.api === "google-generative-ai" && model.input.includes("audio"),
        ),
      }) as Extract<Message, { role: "user" }>;
    }) as Message[],
    target,
    normalizeToolCallId,
  );
}

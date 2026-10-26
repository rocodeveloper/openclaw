import {
  PROVIDER_CONTEXT_HANDOFF,
  resolveProviderContext,
  type ProviderStreamOptions,
} from "../provider-types.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  runGoogleGenerateContentLifecycle,
  type GoogleGenerateContentClient,
  type GoogleProviderOptions,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export function createGoogleGenerateContentStreams<
  T extends "google-generative-ai" | "google-vertex",
>(
  api: T,
  createClient: (model: Model<T>, options?: GoogleProviderOptions) => GoogleGenerateContentClient,
  resolveSimpleApiKey?: (model: Model<T>, options?: SimpleStreamOptions) => string,
): {
  stream: StreamFunction<T, GoogleProviderOptions>;
  streamSimple: StreamFunction<T, SimpleStreamOptions>;
} {
  let toolCallCounter = 0;
  const stream: StreamFunction<T, GoogleProviderOptions> = (model, context, options) => {
    const events = new AssistantMessageEventStream();
    void runGoogleGenerateContentLifecycle({
      stream: events,
      model,
      output: createAssistantOutput(model, api),
      options,
      createClient: () => createClient(model, options),
      buildParams: async () => {
        const providerContext =
          api === "google-generative-ai" ? await resolveProviderContext(context, options) : context;
        options?.signal?.throwIfAborted();
        return buildGoogleGenerateContentParams(model, providerContext, options);
      },
      nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
    });
    return events;
  };
  return {
    stream,
    streamSimple: (model, context, options) => {
      const providerOptions: ProviderStreamOptions | undefined = options;
      return stream(model, context, {
        ...buildBaseOptions(model, options, resolveSimpleApiKey?.(model, options)),
        thinking: buildGoogleSimpleThinking(model, options),
        [PROVIDER_CONTEXT_HANDOFF]: providerOptions?.[PROVIDER_CONTEXT_HANDOFF],
      });
    },
  };
}

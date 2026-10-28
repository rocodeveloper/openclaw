import { normalizeResolvedPricing } from "@openclaw/llm-core";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { withProviderModelInput } from "../../../packages/ai/src/provider-types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { resolveProviderModelInput } from "./model.inline-provider.js";

export function modelFromStaticCatalogRow(row: NormalizedModelCatalogRow): ProviderRuntimeModel {
  return withProviderModelInput(
    {
      id: row.id,
      name: row.name || row.id,
      provider: row.provider,
      api: row.api ?? "openai-responses",
      baseUrl: row.baseUrl ?? "",
      reasoning: row.reasoning,
      cost: normalizeResolvedPricing(row.cost ?? {}),
      contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      contextWindows: row.contextWindows?.map((option) => ({ ...option })),
      contextWindowDefault: row.contextWindowDefault,
      contextTokens: row.contextTokens,
      maxTokens: row.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      thinkingLevelMap: row.thinkingLevelMap ? { ...row.thinkingLevelMap } : undefined,
      headers: row.headers,
      compat: row.compat,
      mediaInput: row.mediaInput,
    } satisfies Omit<ProviderRuntimeModel, "input">,
    resolveProviderModelInput({ input: row.input }),
  );
}

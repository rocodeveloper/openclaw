import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getProviderModelInput } from "../../../packages/ai/src/provider-types.js";
import {
  applyConfiguredProviderOverrides,
  mergeCatalogInlineModel,
} from "./model.configured-overrides.js";
import { buildInlineProviderModels, completeInlineProviderModel } from "./model.inline-provider.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { makeModel } from "./model.test-harness.js";

describe("buildInlineProviderModels", () => {
  it.each([
    { name: "no model override", models: [], expected: ["text", "audio"] },
    { name: "text-only override", models: [makeModel("native-model")], expected: ["text"] },
  ])(
    "preserves only the effective configured media capability for $name",
    ({ models, expected }) => {
      const provider = "audio-fixture";
      const providerConfig = {
        api: "google-generative-ai" as const,
        baseUrl: "https://proxy.example.test/v1beta",
        models,
      };
      const discoveredModel = completeInlineProviderModel(
        {
          ...makeModel("native-model"),
          provider,
          input: ["text", "audio"],
        },
        providerConfig,
      );
      const resolved = expectDefined(
        applyConfiguredProviderOverrides({
          provider,
          modelId: "native-model",
          discoveredModel,
          providerConfig,
          manifestAlias: { provider },
          runtimeHooks: createProviderRuntimeTestMock({ handledDynamicProviders: [] }),
        }),
        "resolved model",
      );
      expect(resolved.input).toEqual(["text"]);
      expect(getProviderModelInput(resolved)).toEqual(expected);
      expect(getProviderModelInput(mergeCatalogInlineModel(discoveredModel, resolved))).toEqual(
        expected,
      );
    },
  );

  it("inherits the configured Pi transport for models without an API override", () => {
    expect(
      buildInlineProviderModels({
        "custom-pi": {
          baseUrl: "https://pi.example.com",
          api: "pi-messages",
          models: [makeModel("custom-model")],
        },
      }),
    ).toMatchObject([{ provider: "custom-pi", api: "pi-messages" }]);
  });

  it("normalizes bare Google API hosts for custom Google Generative AI providers", () => {
    expect(
      buildInlineProviderModels({
        "google-paid ": {
          baseUrl: "https://generativelanguage.googleapis.com",
          api: "google-generative-ai",
          models: [makeModel("gemini-2.5-pro")],
        },
      }),
    ).toMatchObject([
      {
        provider: "google-paid",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    ]);
  });

  it("merges provider request headers into inline models", () => {
    const result = buildInlineProviderModels({
      proxy: {
        baseUrl: "https://proxy.example.com/v1",
        api: "openai-completions",
        request: { headers: { "X-Tenant": "acme" } },
        models: [makeModel("proxy-model")],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.headers).toEqual({ "X-Tenant": "acme" });
  });

  it("drops SecretRef marker headers in inline provider models", () => {
    const result = buildInlineProviderModels({
      custom: {
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
        models: [makeModel("custom-model")],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.headers).toEqual({ "X-Static": "tenant-a" });
  });
});

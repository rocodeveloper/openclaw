import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export type WikiGroupMcpConfig = {
  url: string;
  allowedTools: string[];
  authHeader: string;
  authScheme: string;
  timeoutMs: number;
  maxResponseChars: number;
  credentialFile: string;
};

function nonEmptyTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveDefaultCredentialFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "credentials", "wiki-mcp-tokens.json");
}

export function normalizeConfig(raw: Record<string, unknown> = {}): WikiGroupMcpConfig {
  return {
    url: typeof raw.url === "string" ? raw.url.trim() : "",
    allowedTools: Array.isArray(raw.allowedTools)
      ? [
          ...new Set(
            raw.allowedTools
              .map(nonEmptyTrimmed)
              .filter((item): item is string => item !== undefined),
          ),
        ]
      : [],
    authHeader: nonEmptyTrimmed(raw.authHeader) ?? "Authorization",
    authScheme: typeof raw.authScheme === "string" ? raw.authScheme.trim() : "Bearer",
    timeoutMs: Number.isInteger(raw.timeoutMs) ? (raw.timeoutMs as number) : 30000,
    maxResponseChars: Number.isInteger(raw.maxResponseChars)
      ? (raw.maxResponseChars as number)
      : 100000,
    credentialFile: nonEmptyTrimmed(raw.credentialFile) ?? resolveDefaultCredentialFile(),
  };
}

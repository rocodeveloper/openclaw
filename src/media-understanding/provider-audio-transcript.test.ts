import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendProviderAudioTranscripts } from "../agents/embedded-agent-runner/run/images.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import * as fsSafe from "../infra/fs-safe.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { applyMediaUnderstanding } from "./apply.js";
import { clearRememberedAudioTranscripts } from "./audio-delivery.js";
import { primeAudioTranscript, transcribeProviderAudioFact } from "./provider-audio-transcript.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";

describe("provider transcript source ownership", () => {
  afterEach(() => {
    clearRememberedAudioTranscripts();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses shared workspace aliases in both transcript cache paths", async () => {
    await withTestDir({ prefix: "openclaw-transcript-roots-" }, async (dir) => {
      const stateDir = path.join(dir, "state");
      const workspaceDir = path.join(stateDir, "sandboxes", "session-a");
      const sharedDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(sharedDir, { recursive: true });
      const alias = path.join(workspaceDir, "alias");
      await fs.symlink(sharedDir, alias, "dir");
      const bytes = createSafeAudioFixtureBuffer();
      await fs.writeFile(path.join(sharedDir, "voice.wav"), bytes);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        tools: {
          media: {
            models: [
              {
                type: "cli",
                command: process.execPath,
                args: ["-e", 'process.stdout.write("forbidden transcript")'],
                capabilities: ["audio"],
              },
            ],
          },
        },
      };
      const fact = {
        path: path.join(alias, "voice.wav"),
        contentType: "audio/wav",
        messageId: "roots",
      };
      const results = await Promise.allSettled([
        primeAudioTranscript({ fact, cfg, ctx: { media: [fact] }, workspaceDir }),
        transcribeProviderAudioFact({ fact, bytes, cfg, workspaceDir }),
      ]);
      expect(results).toEqual([
        { status: "rejected", reason: expect.objectContaining({ reason: "blocked" }) },
        { status: "fulfilled", value: undefined },
      ]);
    });
  });

  it("reuses an admitted source across priming and webchat fallbacks while isolating tenant changes", async () => {
    await withTestDir({ prefix: "openclaw-transcript-source-" }, async (dir) => {
      const callsPath = path.join(dir, "calls.txt");
      const mediaPath = path.join(dir, "voice.wav");
      const bytes = createSafeAudioFixtureBuffer();
      await fs.writeFile(mediaPath, bytes);
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        tools: {
          media: {
            models: [
              {
                type: "cli",
                command: process.execPath,
                args: [
                  "-e",
                  'require("node:fs").appendFileSync(process.argv[1], "call\\n"); process.stdout.write("spoken words");',
                  callsPath,
                ],
                capabilities: ["audio"],
              },
            ],
          },
        },
      };
      const fact = {
        path: mediaPath,
        contentType: "audio/wav",
        messageId: "source-a",
        workspaceDir: dir,
      };
      const scope = {
        agentId: "agent-a",
        AccountId: "account-a",
        SessionKey: "agent:agent-a:webchat:one",
        Surface: "webchat",
        ChatType: "direct",
      };
      await primeAudioTranscript({
        fact,
        cfg,
        ctx: { ...scope, MessageSid: "reply-target", media: [fact] },
        agentId: scope.agentId,
        workspaceDir: dir,
      });
      const request = { fact, bytes, cfg, scope, workspaceDir: dir };
      await expect(transcribeProviderAudioFact(request)).resolves.toBe("spoken words");
      await expect(transcribeProviderAudioFact(request)).resolves.toBe("spoken words");
      expect(await fs.readFile(callsPath, "utf8")).toBe("call\n");
      for (const change of [
        { scope: { ...scope, agentId: "agent-b" } },
        { scope: { ...scope, AccountId: "account-b" } },
        { scope: { ...scope, SessionKey: "agent:agent-a:webchat:two" } },
        { fact: { ...fact, messageId: "source-b" } },
      ]) {
        await expect(transcribeProviderAudioFact({ ...request, ...change })).resolves.toBe(
          "spoken words",
        );
      }
      expect(await fs.readFile(callsPath, "utf8")).toBe("call\n".repeat(5));
      const firstInput: MsgContext = { media: [fact, { ...fact, messageId: undefined }] };
      const secondInput: MsgContext = { media: [{ ...fact, messageId: undefined }] };
      const disabled: OpenClawConfig = {
        plugins: { enabled: false },
        tools: { media: { audio: { enabled: false } } },
      };
      await applyMediaUnderstanding({
        ctx: firstInput,
        cfg: disabled,
        processingMode: "audio-only",
        workspaceDir: dir,
      });
      await applyMediaUnderstanding({
        ctx: secondInput,
        cfg: disabled,
        processingMode: "audio-only",
        workspaceDir: dir,
      });
      expect(firstInput.media?.[0]?.messageId).toBe("source-a");
      expect(firstInput.media?.[1]?.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(secondInput.media?.[0]?.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(firstInput.media?.[1]?.messageId).not.toBe(secondInput.media?.[0]?.messageId);
      const anonymous = { ...request, fact: { ...fact, messageId: undefined } };
      await transcribeProviderAudioFact(anonymous);
      await transcribeProviderAudioFact(anonymous);
      expect(await fs.readFile(callsPath, "utf8")).toBe("call\n".repeat(7));
    });
  });
  it.each(["read", "cli"] as const)(
    "cancels real transcript work during %s and permits a fresh owner",
    async (phase) => {
      await withTestDir({ prefix: "openclaw-transcript-cancel-" }, async (dir) => {
        const mediaPath = path.join(dir, "voice.wav");
        const callsPath = path.join(dir, "calls.txt");
        const releasePath = path.join(dir, "release");
        const bytes = createSafeAudioFixtureBuffer();
        await fs.writeFile(mediaPath, bytes);
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          tools: {
            media: {
              models: [
                {
                  type: "cli",
                  command: process.execPath,
                  args: [
                    "-e",
                    'const fs=require("node:fs"); fs.appendFileSync(process.argv[1], "call\\n"); const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer); process.stdout.write("current words");}},10);',
                    callsPath,
                    releasePath,
                  ],
                  capabilities: ["audio"],
                },
              ],
            },
          },
        };
        const fact = {
          path: mediaPath,
          contentType: "audio/wav",
          messageId: "cancel-source",
          workspaceDir: dir,
        };
        const scope = {
          agentId: "agent-a",
          AccountId: "account-a",
          SessionKey: "agent:agent-a:webchat:one",
          Surface: "webchat",
        };
        const controller = new AbortController();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const open = fsSafe.openLocalFileSafely;
        if (phase === "read") {
          vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementationOnce(async (params) => {
            const handle = await open(params);
            entered.resolve();
            await release.promise;
            return handle;
          });
        }
        const pending = primeAudioTranscript({
          fact,
          cfg,
          ctx: { ...scope, media: [fact] },
          agentId: scope.agentId,
          workspaceDir: dir,
          signal: controller.signal,
        });
        const outcome = pending.then(
          () => "accepted",
          () => "cancelled",
        );
        try {
          if (phase === "read") {
            await entered.promise;
          } else {
            await vi.waitFor(async () =>
              expect(await fs.readFile(callsPath, "utf8")).toBe("call\n"),
            );
          }
          controller.abort();
          release.resolve();
          await expect(outcome).resolves.toBe("cancelled");
          await fs.writeFile(releasePath, "release");
          const fresh = await transcribeProviderAudioFact({
            fact,
            bytes,
            cfg,
            scope,
            workspaceDir: dir,
          });
          expect(fresh).toBe("current words");
          expect(await fs.readFile(callsPath, "utf8")).toBe(
            "call\n".repeat(phase === "read" ? 1 : 2),
          );
        } finally {
          controller.abort();
          release.resolve();
          await fs.writeFile(releasePath, "release");
          await outcome;
        }
      });
    },
  );

  it.each(["first", "last"] as const)(
    "records exact successful facts before replay and keeps completed %s selection slots occupied",
    async (prefer) => {
      await withTestDir({ prefix: "openclaw-transcript-replay-" }, async (dir) => {
        const callsPath = path.join(dir, "calls.txt");
        const facts = await Promise.all(
          ["first.wav", "second.wav"].map(async (name) => {
            const mediaPath = path.join(dir, name);
            await fs.writeFile(mediaPath, createSafeAudioFixtureBuffer());
            return {
              path: mediaPath,
              contentType: "audio/wav",
              workspaceDir: dir,
              messageId: "source-replay",
            };
          }),
        );
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          tools: {
            media: {
              models: [
                {
                  type: "cli",
                  command: process.execPath,
                  args: [
                    "-e",
                    'require("node:fs").appendFileSync(process.argv[1], "call\\n"); process.stdout.write("spoken words");',
                    callsPath,
                  ],
                  capabilities: ["audio"],
                },
              ],
              audio: { attachments: { mode: "all", maxAttachments: 1, prefer } },
            },
          },
        };
        const ctx: MsgContext = { Body: "caption", media: [{}, ...facts] };
        await applyMediaUnderstanding({
          ctx,
          cfg,
          workspaceDir: dir,
          processingMode: "audio-only",
        });
        expect(ctx.media?.map((fact) => fact.transcribed === true)).toEqual(
          prefer === "last" ? [false, false, true] : [false, true, false],
        );
        const message = {
          role: "user" as const,
          content: ctx.agentText ?? "caption",
          timestamp: 0,
          __openclaw: { media: ctx.media },
        };
        const projected = await appendProviderAudioTranscripts([message], {
          attachments: cfg.tools?.media?.audio?.attachments,
          workspaceDir: dir,
          transcribe: (fact, bytes) =>
            transcribeProviderAudioFact({ fact, bytes, cfg, workspaceDir: dir }),
        });
        expect(projected[0]).toMatchObject({ role: "user", content: message.content });
        expect(await fs.readFile(callsPath, "utf8")).toBe("call\n");
      });
    },
  );
});

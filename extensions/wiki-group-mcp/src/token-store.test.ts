import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteGroupToken, getGroupToken, setGroupToken } from "./token-store.js";

describe("wiki-group-mcp token store", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("stores independent group tokens in a mode-0600 file", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-group-mcp-"));
    const file = path.join(directory, "credentials", "tokens.json");

    await Promise.all([
      setGroupToken(file, "111@g.us", "token-one"),
      setGroupToken(file, "222@g.us", "token-two"),
    ]);
    expect(await getGroupToken(file, "111@g.us")).toBe("token-one");
    expect(await getGroupToken(file, "222@g.us")).toBe("token-two");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await deleteGroupToken(file, "111@g.us")).toBe(true);
    expect(await getGroupToken(file, "111@g.us")).toBeNull();
    expect(await getGroupToken(file, "222@g.us")).toBe("token-two");
  });
});

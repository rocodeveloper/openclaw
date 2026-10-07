import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyHookMetadata, listHookMetadataOutputs } from "../../scripts/copy-hook-metadata.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeHook(rootDir: string, hookName: string, files: Record<string, string>) {
  const hookDir = path.join(rootDir, "src", "hooks", "bundled", hookName);
  fs.mkdirSync(hookDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(hookDir, fileName), content);
  }
}

describe("copyHookMetadata", () => {
  it("copies HOOK.md and shell scripts of each bundled hook", () => {
    const rootDir = tempDirs.make("copy-hook-metadata-");
    writeHook(rootDir, "with-scripts", {
      "HOOK.md": "# hook",
      "handler.ts": "export default () => {};",
      "b.sh": "echo b",
      "a.sh": "echo a",
    });
    writeHook(rootDir, "without-manifest", { "orphan.sh": "echo orphan" });

    expect(listHookMetadataOutputs({ rootDir })).toEqual([
      "dist/bundled/with-scripts/HOOK.md",
      "dist/bundled/with-scripts/a.sh",
      "dist/bundled/with-scripts/b.sh",
    ]);
    expect(copyHookMetadata({ rootDir })).toBe(3);

    const distHook = path.join(rootDir, "dist", "bundled", "with-scripts");
    expect(fs.readdirSync(distHook).toSorted()).toEqual(["HOOK.md", "a.sh", "b.sh"]);
    expect(fs.existsSync(path.join(rootDir, "dist", "bundled", "without-manifest"))).toBe(false);
  });
});

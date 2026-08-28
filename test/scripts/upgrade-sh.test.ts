import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "upgrade.sh";

function runUpgrade(...args: string[]) {
  return spawnSync("bash", [SCRIPT_PATH, ...args], {
    encoding: "utf8",
  });
}

describe("upgrade.sh", () => {
  it("passes bash syntax validation", () => {
    execFileSync("bash", ["-n", SCRIPT_PATH]);
  });

  it("requires an explicit artifact selection in deploy-only mode", () => {
    const result = runUpgrade("--deploy-only");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--deploy-only requires --run-id RUN_ID or --commit SHA");
  });

  it("rejects malformed explicit artifact selections before contacting GitHub", () => {
    const runResult = runUpgrade("--deploy-only", "--run-id", "not-a-run");
    const commitResult = runUpgrade("--deploy-only", "--commit", "short-sha");

    expect(runResult.status).toBe(2);
    expect(runResult.stderr).toContain("Run ID must contain only digits");
    expect(commitResult.status).toBe(2);
    expect(commitResult.stderr).toContain("full 40-character SHA");
  });

  it("keeps run selection and installation recovery tied to explicit paths", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");

    expect(source).toContain('COMMIT_SHA="$(git rev-parse "$BRANCH^{commit}")"');
    expect(source).toContain('--commit "$commit_sha"');
    expect(source).toContain('gh run download "$RUN_ID"');
    expect(source).toContain('STAGING_DIR="${INSTALL_DIR}.staging.$$"');
    expect(source).toContain('PREVIOUS_DIR="${INSTALL_DIR}.previous.$$"');
    expect(source).toContain("rollback_transaction()");
    expect(source).toContain("node scripts/postinstall-bundled-plugins.mjs");
    expect(source).not.toContain('rm -rf "$INSTALL_DIR"');
    expect(source).not.toContain("--status success --limit 1");
  });
});

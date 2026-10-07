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

  it("requires an explicit release selection in deploy-only mode", () => {
    const result = runUpgrade("--deploy-only");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--deploy-only requires --tag TAG or --commit SHA");
  });

  it("rejects malformed explicit selections before contacting GitHub", () => {
    const tagResult = runUpgrade("--deploy-only", "--tag", "v2026.9.8");
    const commitResult = runUpgrade("--deploy-only", "--commit", "short-sha");
    const bothResult = runUpgrade(
      "--deploy-only",
      "--tag",
      "rocobot-2026.9.8-0123456789ab",
      "--commit",
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(tagResult.status).toBe(2);
    expect(tagResult.stderr).toContain("rocobot-<version>-<12-character sha>");
    expect(commitResult.status).toBe(2);
    expect(commitResult.stderr).toContain("full 40-character SHA");
    expect(bothResult.status).toBe(2);
    expect(bothResult.stderr).toContain("not both");
  });

  it("keeps release selection and installation recovery tied to explicit commits", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");

    expect(source).toContain('COMMIT_SHA="$(git rev-parse "$BRANCH^{commit}")"');
    expect(source).toContain('--commit "$commit_sha"');
    expect(source).toContain('gh release download "$RELEASE_TAG"');
    expect(source).toContain('"$(get_release_commit "$RELEASE_TAG")" != "$COMMIT_SHA"');
    expect(source).toContain('STAGING_DIR="${INSTALL_DIR}.staging.$$"');
    expect(source).toContain('PREVIOUS_DIR="${INSTALL_DIR}.previous.$$"');
    expect(source).toContain("rollback_transaction()");
    expect(source).toContain("node scripts/postinstall-bundled-plugins.mjs");
    expect(source).not.toContain('rm -rf "$INSTALL_DIR"');
    expect(source).not.toContain("--status success --limit 1");
    expect(source).not.toMatch(/git\s+push/);
  });
});

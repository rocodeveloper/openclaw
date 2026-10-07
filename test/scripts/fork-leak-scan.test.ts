import { describe, expect, it } from "vitest";
import { findDiffLeaks, findLineLeaks, parseTerms } from "../../scripts/fork-leak-scan.mjs";

const SAMPLE_DIGITS = ["44", "7700", "912345"].join("");
const ROOT_DIR = ["", "root", ""].join("/");

describe("fork-leak-scan", () => {
  it.each([
    "ping @+15551234567",
    "ping @+12025550123",
    "15551234567@s.whatsapp.net",
    "120363000000000000@g.us",
    "visible @+100000000000001",
    "path /tmp/agent",
  ])("accepts placeholder text %s", (text) => {
    expect(findLineLeaks(text, [])).toEqual([]);
  });

  it.each([
    [`ping @+${SAMPLE_DIGITS}`, "e164"],
    [`${SAMPLE_DIGITS}@s.whatsapp.net`, "phone-jid"],
    [`${SAMPLE_DIGITS}:3@s.whatsapp.net`, "phone-jid"],
    [`${SAMPLE_DIGITS}-1600000000@g.us`, "group-jid"],
    [`cd ${ROOT_DIR}project`, "root-path"],
  ])("flags %s as %s", (text, rule) => {
    expect(findLineLeaks(text, [])).toEqual([rule]);
  });

  it("matches private terms as whole words without case", () => {
    const terms = parseTerms("alice\n\n  acct-x \n");

    expect(findLineLeaks("hello Alice", terms)).toEqual(["term-1"]);
    expect(findLineLeaks("account acct-x", terms)).toEqual(["term-2"]);
    expect(findLineLeaks("malice", terms)).toEqual([]);
  });

  it("reports only added lines with their new line numbers", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +20,3 @@",
      `-const old = '+${SAMPLE_DIGITS}';`,
      " const kept = 1;",
      `+const added = '${ROOT_DIR}tmp';`,
      "+const fine = '+15551234567';",
    ].join("\n");

    expect(findDiffLeaks(diff, [])).toEqual([{ file: "src/a.ts", line: 21, rule: "root-path" }]);
  });
});

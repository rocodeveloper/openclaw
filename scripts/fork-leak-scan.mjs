#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_PHONE_PATTERNS = [
  /^1555\d{7}$/,
  /^1\d{3}555\d{4}$/,
  /^0+$/,
  /^1234567\d{0,8}$/,
  /^10{6,}\d{0,6}$/,
];
const PLACEHOLDER_GROUP_PATTERN = /^1203630{6,}\d{0,6}$/;

const E164_PATTERN = /(?<![\w+])\+(\d{8,15})(?!\d)/g;
const USER_JID_PATTERN = /(?<!\d)(\d{8,15})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)\b/g;
const GROUP_JID_PATTERN = /(?<![\w-])(\d{8,20}(?:-\d+)?)@g\.us\b/g;
const ROOT_PATH_PATTERN = /(?<![\w.])\/root\//;

function isPlaceholderPhone(digits) {
  return PLACEHOLDER_PHONE_PATTERNS.some((pattern) => pattern.test(digits));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseTerms(raw) {
  return (raw ?? "")
    .split(/\r?\n/)
    .map((term) => term.trim())
    .filter(Boolean);
}

export function findLineLeaks(text, terms) {
  const rules = new Set();
  for (const match of text.matchAll(E164_PATTERN)) {
    if (!isPlaceholderPhone(match[1])) {
      rules.add("e164");
    }
  }
  for (const match of text.matchAll(USER_JID_PATTERN)) {
    if (!isPlaceholderPhone(match[1])) {
      rules.add("phone-jid");
    }
  }
  for (const match of text.matchAll(GROUP_JID_PATTERN)) {
    if (!PLACEHOLDER_GROUP_PATTERN.test(match[1])) {
      rules.add("group-jid");
    }
  }
  if (ROOT_PATH_PATTERN.test(text)) {
    rules.add("root-path");
  }
  terms.forEach((term, index) => {
    if (new RegExp(`(?<![\\w])${escapeRegExp(term)}(?![\\w])`, "i").test(text)) {
      rules.add(`term-${index + 1}`);
    }
  });
  return [...rules];
}

export function findDiffLeaks(diff, terms) {
  const leaks = [];
  let file = "";
  let line = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("+++ ")) {
      file = row.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (row.startsWith("+")) {
      for (const rule of findLineLeaks(row.slice(1), terms)) {
        leaks.push({ file, line, rule });
      }
      line += 1;
    } else if (!row.startsWith("-")) {
      line += 1;
    }
  }
  return leaks;
}

function main() {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: fork-leak-scan.mjs <base-ref> [head-ref]");
    process.exit(2);
  }
  const head = process.argv[3] ?? "HEAD";
  const terms = parseTerms(process.env.FORK_LEAK_TERMS);
  if (terms.length === 0) {
    console.error("FORK_LEAK_TERMS is empty; refusing to scan without the private term list.");
    process.exit(2);
  }
  const diff = execFileSync(
    "git",
    ["diff", "--unified=0", "--no-color", "--no-ext-diff", `${base}...${head}`],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  const leaks = findDiffLeaks(diff, terms);
  for (const leak of leaks) {
    console.error(`${leak.file}:${leak.line}: ${leak.rule}`);
  }
  if (leaks.length > 0) {
    console.error(`Leak scan failed: ${leaks.length} finding(s) against ${base}.`);
    process.exit(1);
  }
  console.log(`Leak scan passed against ${base} with ${terms.length} private term(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

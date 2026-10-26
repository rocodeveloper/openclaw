import type { WhatsAppSelfIdentity } from "../../identity.js";

export function stripMentionsForCommand(
  text: string,
  mentionRegexes: RegExp[],
  self: WhatsAppSelfIdentity,
): string {
  const aliases = new Set<string>();
  for (const value of [self.e164, self.jid, self.lid]) {
    if (!value) {
      continue;
    }
    const local = value.split("@")[0]?.replace(/:\d+$/, "");
    aliases.add(value);
    aliases.add(`@${value}`);
    if (local) {
      aliases.add(`@${local}`);
      aliases.add(`@${local.replace(/^\+/, "")}`);
    }
  }
  let remaining = text.trimStart();
  while (remaining) {
    const token = [...aliases].find(
      (alias) =>
        remaining.startsWith(alias) &&
        (remaining.length === alias.length ||
          /^[\s\u200b-\u200f\ufeff]/u.test(remaining.slice(alias.length))),
    );
    const matched =
      token ??
      mentionRegexes
        .map((pattern) => {
          const match = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).exec(
            remaining,
          );
          return match?.index === 0 &&
            match[0].length > 0 &&
            (match[0].length === remaining.length ||
              /^[\s\u200b-\u200f\ufeff]/u.test(remaining.slice(match[0].length)))
            ? match[0]
            : undefined;
        })
        .find((value) => value !== undefined);
    if (!matched) {
      return remaining;
    }
    remaining = remaining.slice(matched.length).replace(/^[\s\u200b-\u200f\ufeff]+/u, "");
  }
  return remaining;
}

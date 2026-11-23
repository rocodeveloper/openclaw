import { createToolPolicyMatcher } from "../agents/tool-policy-match.js";
import {
  expandToolGroups,
  normalizeToolList,
  readToolAllowlistIntersection,
} from "../agents/tool-policy.js";

const normalizeHookToolsAllow = (value: unknown): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
};

export const readHookToolsAllowRestrictions = (value: unknown): string[][] => {
  const normalized = normalizeHookToolsAllow(value);
  if (normalized === undefined) {
    return [];
  }
  const attached = Array.isArray(value) ? readToolAllowlistIntersection(value) : undefined;
  return attached
    ? attached.map((restriction) => normalizeHookToolsAllow(restriction) ?? [])
    : [normalized];
};

export const intersectToolsAllow = (left: string[] | undefined, right: string[]): string[] => {
  if (left === undefined) {
    return right;
  }
  if (left.length === 0 || right.length === 0) {
    return [];
  }
  const normalizedLeft = normalizeToolList(expandToolGroups(left));
  const normalizedRight = normalizeToolList(expandToolGroups(right));
  if (normalizedLeft.includes("*")) {
    return normalizedRight;
  }
  if (normalizedRight.includes("*")) {
    return normalizedLeft;
  }
  const matchesLeft = createToolPolicyMatcher({ allow: normalizedLeft });
  const matchesRight = createToolPolicyMatcher({ allow: normalizedRight });
  return [...new Set(normalizeToolList([...normalizedLeft, ...normalizedRight]))].filter(
    (name) => matchesLeft(name) && matchesRight(name),
  );
};

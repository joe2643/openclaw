import { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";

function appendNormalizedUnique(entries: Iterable<string>, seen: Set<string>, ordered: string[]) {
  for (const entry of entries) {
    // For phone numbers, normalizeE164 returns the canonical E.164 form.
    // For LID JIDs (e.g. "101653353078797:1@hosted.lid"), strip device suffix
    // and domain so the agent sees a clean number it can use for @mentions.
    const normalized =
      normalizeE164(entry) ??
      (entry.includes("@") ? entry.replace(/:[\d]+@.*$/, "").replace(/@.*$/, "") : entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
}

export function noteGroupMember(
  groupMemberNames: Map<string, Map<string, string>>,
  conversationId: string,
  e164?: string,
  name?: string,
) {
  if (!e164 || !name) {
    return;
  }
  const normalized = normalizeE164(e164);
  const key = normalized ?? e164;
  if (!key) {
    return;
  }
  let roster = groupMemberNames.get(conversationId);
  if (!roster) {
    roster = new Map();
    groupMemberNames.set(conversationId, roster);
  }
  roster.set(key, name);
}

export function formatGroupMembers(params: {
  participants: string[] | undefined;
  roster: Map<string, string> | undefined;
  fallbackE164?: string;
}) {
  const { participants, roster, fallbackE164 } = params;
  const seen = new Set<string>();
  const ordered: string[] = [];
  if (participants?.length) {
    appendNormalizedUnique(participants, seen, ordered);
  }
  if (roster) {
    appendNormalizedUnique(roster.keys(), seen, ordered);
  }
  if (ordered.length === 0 && fallbackE164) {
    const normalized = normalizeE164(fallbackE164) ?? fallbackE164;
    if (normalized) {
      ordered.push(normalized);
    }
  }
  if (ordered.length === 0) {
    return undefined;
  }
  return ordered
    .map((entry) => {
      const name = roster?.get(entry);
      return name ? `${name} (${entry})` : entry;
    })
    .join(", ");
}

import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type Message = AgentMessage;
export interface OriginalIdentity { hash: string; position: number }
export interface Row {
  key: string; message: Message; collapseId?: string;
  /** Unmodified audit message when projection removes only some assistant blocks. */
  auditMessage?: Message;
  /** Runtime-only provenance from the audit history, never model-visible or archived. */
  originals?: OriginalIdentity[];
  originalCount?: number;
  legacyKey?: string;
}
export const isArchiveId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export interface Collapse {
  version: 1;
  /** Missing in legacy journals, whose keys used pre-JSON-normalization hashing. */
  identityVersion?: 2;
  /** Selection used a projection without successful collapse bookkeeping. */
  hideBookkeeping?: true;
  id: string;
  keys: string[];
  summary: string;
  timestamp: number;
  originalCount: number;
  supersedes: string[];
}
export interface Config { triggerPercent: number; targetPercent: number; protectRecent: number }
export const DEFAULT_CONFIG: Config = { triggerPercent: 85, targetPercent: 50, protectRecent: 0 };
export const OP_TYPE = "collapse.operation.v1";
export const CONFIG_TYPE = "collapse.config.v1";
export const FORCE_TYPE = "collapse.force.v1";

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !Object.keys(DEFAULT_CONFIG).includes(k))) throw new Error("Unknown configuration key");
  const { triggerPercent, targetPercent, protectRecent } = v;
  if (typeof triggerPercent !== "number" || !Number.isFinite(triggerPercent) || triggerPercent <= 0 || triggerPercent >= 100 ||
      typeof targetPercent !== "number" || !Number.isFinite(targetPercent) || targetPercent <= 0 || targetPercent >= triggerPercent ||
      typeof protectRecent !== "number" || !Number.isSafeInteger(protectRecent) || protectRecent < 0) {
    throw new Error("Require 0 < targetPercent < triggerPercent < 100 and integer protectRecent >= 0");
  }
  return { triggerPercent, targetPercent, protectRecent };
}

function legacyCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(legacyCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${legacyCanonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Hash the JSON representation that pi persists, including toJSON and sparse arrays. */
export function canonical(value: unknown): string {
  const json = JSON.stringify(value);
  return legacyCanonical(json === undefined ? null : JSON.parse(json));
}

function identityValue(message: Message): unknown {
  // Pi regenerates custom-message timestamps when persisting/rebuilding them.
  return message.role === "custom" ? { ...message, timestamp: undefined } : message;
}
const hashValue = (value: string) => createHash("sha256").update(value).digest("hex");
export const messageFingerprint = (message: Message): string => hashValue(canonical(identityValue(message)));

export function identify(messages: Message[]): Row[] {
  const counts = new Map<string, number>();
  const legacyCounts = new Map<string, number>();
  return messages.map((message, position) => {
    const hash = messageFingerprint(message);
    const legacyHash = hashValue(legacyCanonical(identityValue(message)));
    const occurrence = counts.get(hash) ?? 0;
    counts.set(hash, occurrence + 1);
    const legacyOccurrence = legacyCounts.get(legacyHash) ?? 0;
    legacyCounts.set(legacyHash, legacyOccurrence + 1);
    const key = `${hash}:${occurrence}`, legacyKey = `${legacyHash}:${legacyOccurrence}`;
    return { key, message, originals: [{ hash, position }], ...(legacyKey !== key ? { legacyKey } : {}) };
  });
}

export function summaryRow(op: Collapse): Row {
  return {
    key: `collapse:${op.id}`, collapseId: op.id, originalCount: op.originalCount,
    message: { role: "custom", customType: "collapse.summary", display: true,
      content: `[Collapsed @collapse:${op.id}; ${op.originalCount} original messages; archive: messages-${op.id}.jsonl]\n${op.summary}`,
      timestamp: op.timestamp },
  };
}

export function validateCollapse(value: unknown): Collapse {
  const op = value as Collapse;
  if (!op || op.version !== 1 || (op.identityVersion !== undefined && op.identityVersion !== 2) ||
      (op.hideBookkeeping !== undefined && op.hideBookkeeping !== true) || !isArchiveId(op.id) || !Array.isArray(op.keys) || !op.keys.length ||
      op.keys.some(k => typeof k !== "string") || new Set(op.keys).size !== op.keys.length ||
      typeof op.summary !== "string" || (op.summary !== "" && !op.summary.trim()) || !Number.isFinite(op.timestamp) ||
      !Number.isSafeInteger(op.originalCount) || op.originalCount < 1 || !Array.isArray(op.supersedes) ||
      op.supersedes.some(id => !isArchiveId(id))) throw new Error("Invalid collapse journal entry");
  return op;
}

/** Pi can remove these responses before retry/overflow hooks run, even if compaction
 * is cancelled. Never reconcile missing tool calls, aborted output, or user data. */
function omittedByPi(message: Message): boolean {
  return message.role === "assistant" && (
    (message.stopReason === "error" && message.content.length === 0) ||
    (message.stopReason === "length" && message.content.every(block => block.type === "text" || block.type === "thinking"))
  );
}

export function apply(rows: Row[], op: Collapse): Row[] {
  // Do not mix namespaces: a legacy Date hash can equal a new plain-object hash.
  const matchesKey = (row: Row, key: string) => (op.identityVersion === 2 ? row.key : row.legacyKey ?? row.key) === key;
  const start = rows.findIndex(r => matchesKey(r, op.keys[0]));
  const conflict = () => new Error(`Cannot replay collapse ${op.id}: history changed or another context extension conflicts. No history was discarded.`);
  if (start < 0) throw conflict();
  let end = start;
  const retained: Row[] = [];
  const selected: Row[] = [];
  for (const key of op.keys) {
    while (rows[end] && !matchesKey(rows[end], key)) {
      const message = rows[end].message;
      // Legacy operations may span a response omitted by Pi's retry/overflow
      // lifecycle. Preserve it outside the replacement, never silently archive
      // content that the original selection did not contain.
      if (!omittedByPi(message)) throw conflict();
      retained.push(rows[end++]);
    }
    if (!rows[end]) throw conflict();
    selected.push(rows[end++]);
  }
  const replacement = summaryRow(op);
  if (selected.every(row => row.originals)) replacement.originals = selected.flatMap(row => row.originals!);
  return [...rows.slice(0, start), ...(op.summary === "" ? [] : [replacement]), ...retained, ...rows.slice(end)];
}

export function project(messages: Message[], operations: Collapse[]): Row[] {
  return operations.reduce(apply, identify(messages));
}

/** Pi clones context before hooks (Buffer -> Uint8Array). Restore audit objects only
 * when the entire sequence matches, allowing narrowly identified Pi omissions.
 * Reinsert truncated text/thinking so new selections include the actual audit
 * content. Empty retry errors retain their legacy omitted-live representation.
 * Never equate arbitrary typed arrays with Buffers or reconcile changed content. */
export function restoreAuditMessages(messages: Message[], audit: Message[]): Message[] {
  const restored: Message[] = [];
  let cursor = 0;
  for (const message of messages) {
    const expected = messageFingerprint(message);
    let matched = false;
    while (cursor < audit.length) {
      const original = audit[cursor++];
      let same = messageFingerprint(original) === expected;
      if (!same) {
        try { same = messageFingerprint(structuredClone(original)) === expected; }
        catch { /* Non-cloneable extension data is not safe to reconcile. */ }
      }
      if (same) {
        // Custom timestamps are intentionally outside identity; retain the live value.
        restored.push(original.role === "custom" && message.role === "custom" && original.timestamp !== message.timestamp
          ? { ...original, timestamp: message.timestamp } : original);
        matched = true;
        break;
      }
      if (!omittedByPi(original)) return messages;
      if (original.role === "assistant" && original.stopReason === "length") restored.push(original);
    }
    if (!matched) return messages;
  }
  const tail = audit.slice(cursor);
  if (!tail.every(omittedByPi)) return messages;
  restored.push(...tail.filter(message => message.role === "assistant" && message.stopReason === "length"));
  return restored;
}

// Search visible content, not details/usage/signatures containing hidden fork transcripts.
// Still expose compact JSON for matching tool arguments and decoded strings for raw text.
export function surfaces(message: Message): string[] {
  let visible: unknown;
  if (message.role === "bashExecution") visible = { role: message.role, command: message.command, output: message.output };
  else if (message.role === "branchSummary" || message.role === "compactionSummary") visible = { role: message.role, summary: message.summary };
  else visible = { role: message.role, content: typeof message.content === "string" ? message.content : message.content.map(block => {
    if (block.type === "text") return { type: block.type, text: block.text };
    if (block.type === "thinking") return { type: block.type, thinking: block.thinking };
    if (block.type === "toolCall") return { type: block.type, id: block.id, name: block.name, arguments: block.arguments };
    return { type: block.type }; // Binary image data and opaque signatures are not selectors.
  }) };
  const result = [JSON.stringify(visible)];
  function visit(value: unknown) {
    if (typeof value === "string") result.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(visible);
  return result;
}

function grams(text: string): Set<string> {
  const value = text.toLowerCase(); // Ranking only; never used to select a message.
  return new Set(Array.from({ length: Math.max(1, value.length - 2) }, (_, i) => value.slice(i, i + 3)));
}

export function suggestions(rows: Row[], match: string): string {
  const query = grams(match.slice(0, 200));
  const words = match.split(/\s+/).filter(Boolean).slice(0, 10);
  return rows.map((row, index) => {
    let best = { text: "", score: -1 };
    for (const text of surfaces(row.message)) {
      const offsets = [0, ...words.map(word => text.toLowerCase().indexOf(word.toLowerCase())).filter(i => i >= 0)];
      for (const offset of offsets) {
        const snippet = text.slice(Math.max(0, offset - 30), Math.max(0, offset - 30) + 180);
        const candidates = grams(snippet);
        const score = [...query].filter(g => candidates.has(g)).length / Math.max(1, query.size);
        if (score > best.score) best = { text: snippet, score };
      }
    }
    return { index, ...best };
  }).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(v => `message ${v.index + 1} (${boundary(rows[v.index])}): ${JSON.stringify(v.text)}`).join("\n");
}

export function boundary(row: Row): string {
  return row.collapseId ? `@collapse:${row.collapseId}` : `@message:${row.key}`;
}

export function matchMessage(rows: Row[], match: string, label: string): number {
  if (!match.length) throw new Error(`${label} cannot be empty`);
  // References resolve metadata, never incidental copies in tool arguments/results.
  if (match.startsWith("@collapse:") && !isArchiveId(match.slice("@collapse:".length))) throw new Error(`${label}: invalid collapse reference. Copy an exact returned reference; do not invent IDs.`);
  if (match.startsWith("@message:") && !/^@message:[0-9a-f]{64}:\d+$/.test(match)) throw new Error(`${label}: invalid message reference. Copy an exact returned reference; do not invent IDs.`);
  const reference = match.startsWith("@collapse:") || match.startsWith("@message:");
  const matches = rows.flatMap((r, i) => (reference ? boundary(r) === match : surfaces(r.message).some(text => text.includes(match))) ? [i] : []);
  if (matches.length !== 1) {
    if (reference) throw new Error(`${label}: reference not found in current history. It may be superseded, removed, or from another session. Use a current returned reference or visible content.`);
    const candidates = matches.length ? matches.slice(0, 3).map(i => {
      const surface = surfaces(rows[i].message).find(text => text.includes(match))!;
      const offset = Math.max(0, surface.indexOf(match) - 40);
      return `message ${i + 1} (${boundary(rows[i])}): ${JSON.stringify((offset ? "…" : "") + surface.slice(offset, offset + 180))}`;
    }).join("\n") : suggestions(rows, match);
    throw new Error(`${label}: ${matches.length ? `ambiguous; matches messages ${matches.slice(0, 20).map(i => i + 1).join(", ")}` : "not found"}. Copy the intended candidate's exact reference for retry; literals are case- and whitespace-sensitive. Use collapse action: "inspect" with query and offset to discover other matches. Closest candidates (suggestions only):\n${candidates}`);
  }
  return matches[0];
}

interface ToolGroups { calls: Map<string, number[]>; results: Map<string, number[]> }

function toolGroups(rows: Row[]): ToolGroups {
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  rows.forEach(({ message: m }, i) => {
    if (m.role === "assistant") for (const block of m.content) {
      if (block.type === "toolCall") calls.set(block.id, [...(calls.get(block.id) ?? []), i]);
    }
    if (m.role === "toolResult") results.set(m.toolCallId, [...(results.get(m.toolCallId) ?? []), i]);
  });
  return { calls, results };
}

/** Expand to a fixed point, including every sibling call/result on an assistant message. */
export function expandRange(rows: Row[], start: number, end: number): [number, number] {
  return expandIndexedRange(rows, start, end, toolGroups(rows));
}

function expandIndexedRange(rows: Row[], start: number, end: number, { calls, results }: ToolGroups): [number, number] {
  if (start > end) throw new Error("startMatch must precede endMatch");
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = start; i <= end; i++) {
      const m = rows[i].message;
      const ids = m.role === "assistant" ? m.content.flatMap(b => b.type === "toolCall" ? [b.id] : []) :
        m.role === "toolResult" ? [m.toolCallId] : [];
      for (const id of ids) {
        const c = calls.get(id) ?? [], r = results.get(id) ?? [];
        if (c.length !== 1 || r.length !== 1) throw new Error(`Tool group ${id} is incomplete or ambiguous; it cannot be collapsed yet`);
        const lo = Math.min(start, c[0], r[0]), hi = Math.max(end, c[0], r[0]);
        if (lo !== start || hi !== end) { start = lo; end = hi; changed = true; }
      }
    }
  }
  return [start, end];
}

export function eligibleRanges(rows: Row[], protectRecent: number): string {
  const candidates: { start: number; end: number; size: number }[] = [];
  const cutoff = Math.max(0, rows.length - protectRecent);
  const groups = toolGroups(rows);
  for (let i = 0; i < cutoff; i++) {
    try {
      const [start, end] = expandIndexedRange(rows, i, i, groups);
      if (start !== i || end >= cutoff) continue;
      candidates.push({ start, end, size: rows.slice(start, end + 1).reduce((sum, row) => sum + JSON.stringify(row.message).length, 0) });
      i = end;
    } catch { /* Incomplete or ambiguous tool groups are never eligible. */ }
  }
  if (!candidates.length) return "No eligible complete ranges remain under current protection. Wait for more completed work; do not split tool groups.";
  return "Eligible complete ranges (largest serialized content first; inspect relevance before selecting; these are not instructions to discard):\n" + candidates.sort((a, b) => b.size - a.size).slice(0, 3).map(({ start, end }) =>
    `messages ${start + 1}–${end + 1}: ${JSON.stringify({ startMatch: boundary(rows[start]), endMatch: boundary(rows[end]) })}`).join("\n");
}

export interface MessageLookup {
  total: number;
  offset: number;
  nextOffset: number | null;
  protectRecent: number;
  matches: Array<{
    message: number; reference: string; role: Message["role"]; preview: string;
    eligible: boolean;
    range?: { startMatch: string; endMatch: string; firstMessage: number; lastMessage: number };
    reason?: string;
  }>;
}

/** Bounded exact-match discovery; offset counts matches, not history rows.
 * References are stable identities, while message numbers are snapshot-local. */
export function lookupMessages(rows: Row[], query = "", offset = 0, limit = 10, protectRecent = 0): MessageLookup {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
      !Number.isSafeInteger(protectRecent) || protectRecent < 0) throw new Error("Require nonnegative integer offset/protectRecent and integer limit 1–20");
  const reference = query.startsWith("@collapse:") || query.startsWith("@message:");
  const found = rows.flatMap((row, index) => {
    const texts = surfaces(row.message);
    const text = query === "" || reference ? texts[0] : texts.find(text => text.includes(query));
    return (reference ? boundary(row) === query : text !== undefined) ? [{ row, index, text: text! }] : [];
  });
  const groups = toolGroups(rows);
  const cutoff = Math.max(0, rows.length - protectRecent);
  const matches = found.slice(offset, offset + limit).map(({ row, index, text }) => {
    const previewStart = query && !reference ? Math.max(0, text.indexOf(query) - 40) : 0;
    const item: MessageLookup["matches"][number] = { message: index + 1, reference: boundary(row), role: row.message.role,
      preview: (previewStart ? "…" : "") + text.slice(previewStart, previewStart + 240), eligible: false };
    try {
      const [start, end] = expandIndexedRange(rows, index, index, groups);
      item.range = { startMatch: boundary(rows[start]), endMatch: boundary(rows[end]), firstMessage: start + 1, lastMessage: end + 1 };
      item.eligible = end < cutoff;
      if (!item.eligible) item.reason = `Expanded range touches the protected latest ${protectRecent} messages`;
    } catch (error) { item.reason = (error instanceof Error ? error.message : String(error)).slice(0, 240); }
    return item;
  });
  return { total: found.length, offset, nextOffset: offset + matches.length < found.length ? offset + matches.length : null, protectRecent, matches };
}

export function selectRange(rows: Row[], startMatch: string, endMatch: string, protectRecent: number): [number, number] {
  const resolved: number[] = [], errors: string[] = [];
  for (const [label, match] of [["startMatch", startMatch], ["endMatch", endMatch]]) {
    try { resolved.push(matchMessage(rows, match, label)); }
    catch (error) { resolved.push(-1); errors.push(String(error instanceof Error ? error.message : error)); }
  }
  if (errors.length) {
    const valid = resolved.flatMap((index, i) => index < 0 ? [] : [`${i === 0 ? "startMatch" : "endMatch"} resolved: ${boundary(rows[index])}`]);
    throw new Error([...errors, ...valid].join("\n"));
  }
  const range = expandRange(rows, resolved[0], resolved[1]);
  if (range[1] >= rows.length - protectRecent) throw new Error(`Range expanded to messages ${range[0] + 1}–${range[1] + 1} (including complete tool groups) touches the protected latest ${protectRecent} messages.\n${eligibleRanges(rows, protectRecent)}`);
  return range;
}

export function nextForced(forced: boolean, percent: number, config: Config): boolean {
  return forced ? percent > config.targetPercent : percent >= config.triggerPercent;
}

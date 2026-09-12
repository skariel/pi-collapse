import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type Message = AgentMessage;
export interface Row { key: string; message: Message; collapseId?: string }
export interface Collapse {
  version: 1;
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

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function identify(messages: Message[]): Row[] {
  const counts = new Map<string, number>();
  return messages.map(message => {
    // Pi regenerates custom-message timestamps when persisting/rebuilding them.
    // Ignore only that unstable field; occurrence ordinals distinguish duplicates.
    const identity = message.role === "custom" ? { ...message, timestamp: undefined } : message;
    const hash = createHash("sha256").update(canonical(identity)).digest("hex");
    const occurrence = counts.get(hash) ?? 0;
    counts.set(hash, occurrence + 1);
    return { key: `${hash}:${occurrence}`, message };
  });
}

export function summaryRow(op: Collapse): Row {
  return {
    key: `collapse:${op.id}`, collapseId: op.id,
    message: { role: "custom", customType: "collapse.summary", display: true,
      content: `[Collapsed ${op.id}; ${op.originalCount} original messages; archive: messages-${op.id}.jsonl]\n${op.summary}`,
      timestamp: op.timestamp },
  };
}

export function validateCollapse(value: unknown): Collapse {
  const op = value as Collapse;
  if (!op || op.version !== 1 || !/^[0-9a-f-]{36}$/.test(op.id) || !Array.isArray(op.keys) || !op.keys.length ||
      op.keys.some(k => typeof k !== "string") || new Set(op.keys).size !== op.keys.length ||
      typeof op.summary !== "string" || (op.summary !== "" && !op.summary.trim()) || !Number.isFinite(op.timestamp) ||
      !Number.isSafeInteger(op.originalCount) || op.originalCount < 1 || !Array.isArray(op.supersedes) ||
      op.supersedes.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))) throw new Error("Invalid collapse journal entry");
  return op;
}

export function apply(rows: Row[], op: Collapse): Row[] {
  const start = rows.findIndex(r => r.key === op.keys[0]);
  const conflict = () => new Error(`Cannot replay collapse ${op.id}: history changed or another context extension conflicts. No history was discarded.`);
  if (start < 0) throw conflict();
  let end = start;
  const retained: Row[] = [];
  for (const key of op.keys) {
    while (rows[end] && rows[end].key !== key) {
      const message = rows[end].message;
      // Pi's automatic retry removes empty failed assistant responses from live
      // context but retains them on disk. Never discard these audit records,
      // and never tolerate inserted user content, tool calls, or partial output.
      if (message.role !== "assistant" || message.stopReason !== "error" || message.content.length !== 0) throw conflict();
      retained.push(rows[end++]);
    }
    if (!rows[end]) throw conflict();
    end++;
  }
  return [...rows.slice(0, start), ...(op.summary === "" ? [] : [summaryRow(op)]), ...retained, ...rows.slice(end)];
}

export function project(messages: Message[], operations: Collapse[]): Row[] {
  return operations.reduce(apply, identify(messages));
}

// Literal JSON plus individual decoded string values: raw newlines and spaces remain matchable.
export function surfaces(message: Message): string[] {
  const result = [JSON.stringify(message)];
  function visit(value: unknown) {
    if (typeof value === "string") result.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(message);
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
  const reference = /^@collapse:[0-9a-f-]{36}$/.test(match) || /^@message:[0-9a-f]{64}:\d+$/.test(match);
  const matches = rows.flatMap((r, i) => (reference ? boundary(r) === match : surfaces(r.message).some(text => text.includes(match))) ? [i] : []);
  if (matches.length !== 1) throw new Error(`${label}: ${matches.length ? `ambiguous; matches messages ${matches.slice(0, 20).map(i => i + 1).join(", ")}` : "not found"}. Use a longer exact, case- and whitespace-sensitive substring. Closest candidates (suggestions only):\n${suggestions(rows, match)}`);
  return matches[0];
}

/** Expand to a fixed point, including every sibling call/result on an assistant message. */
export function expandRange(rows: Row[], start: number, end: number): [number, number] {
  if (start > end) throw new Error("startMatch must precede endMatch");
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  rows.forEach(({ message: m }, i) => {
    if (m.role === "assistant") for (const block of m.content) {
      if (block.type === "toolCall") calls.set(block.id, [...(calls.get(block.id) ?? []), i]);
    }
    if (m.role === "toolResult") results.set(m.toolCallId, [...(results.get(m.toolCallId) ?? []), i]);
  });
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
  for (let i = 0; i < cutoff; i++) {
    try {
      const [start, end] = expandRange(rows, i, i);
      if (start !== i || end >= cutoff) continue;
      candidates.push({ start, end, size: rows.slice(start, end + 1).reduce((sum, row) => sum + JSON.stringify(row.message).length, 0) });
      i = end;
    } catch { /* Incomplete or ambiguous tool groups are never eligible. */ }
  }
  if (!candidates.length) return "No eligible complete ranges remain under current protection. Wait for more completed work; do not split tool groups.";
  return "Eligible complete ranges (largest serialized content first; inspect relevance before selecting; these are not instructions to discard):\n" + candidates.sort((a, b) => b.size - a.size).slice(0, 3).map(({ start, end }) =>
    `messages ${start + 1}–${end + 1}: ${JSON.stringify({ startMatch: boundary(rows[start]), endMatch: boundary(rows[end]) })}`).join("\n");
}

export function selectRange(rows: Row[], startMatch: string, endMatch: string, protectRecent: number): [number, number] {
  const range = expandRange(rows, matchMessage(rows, startMatch, "startMatch"), matchMessage(rows, endMatch, "endMatch"));
  if (range[1] >= rows.length - protectRecent) throw new Error(`Range expanded to messages ${range[0] + 1}–${range[1] + 1} (including complete tool groups) touches the protected latest ${protectRecent} messages.\n${eligibleRanges(rows, protectRecent)}`);
  return range;
}

export function nextForced(forced: boolean, percent: number, config: Config): boolean {
  return forced ? percent > config.targetPercent : percent >= config.triggerPercent;
}

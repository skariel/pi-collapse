import { apply, identify, type Collapse, type Message, type Row } from "./core.ts";

type Assistant = Extract<Message, { role: "assistant" }>;
type ToolCall = Extract<Assistant["content"][number], { type: "toolCall" }>;
interface Pair { call: ToolCall; caller: number; result: number }

export function completionReceipt(id: string): string {
  return `[Collapse completed: ${id}.]`;
}

/** Hide only uniquely paired, successful bookkeeping, retaining opted-in receipts.
 * Raw identities/provenance
 * are retained even when an assistant also contains ordinary text or other calls.
 * Failed calls remain visible for recovery; no audit messages are mutated. */
export function hideBookkeeping(rows: Row[], operations: Collapse[]): Row[] {
  const calls = new Map<string, Array<{ call: ToolCall; caller: number }>>();
  const results = new Map<string, number[]>();
  rows.forEach(({ message }, index) => {
    if (message.role === "assistant") for (const call of message.content) {
      if (call.type === "toolCall") calls.set(call.id, [...(calls.get(call.id) ?? []), { call, caller: index }]);
    }
    if (message.role === "toolResult") results.set(message.toolCallId, [...(results.get(message.toolCallId) ?? []), index]);
  });
  const committed = new Map(operations.map(op => [op.id, op]));
  const mutations = new Map<string, Pair[]>();
  const inspections: Pair[] = [];
  for (const [id, matches] of calls) {
    const paired = results.get(id) ?? [];
    if (matches.length !== 1 || paired.length !== 1) continue;
    const { call, caller } = matches[0];
    const result = paired[0], message = rows[result].message;
    if (caller >= result || call.name !== "collapse" || message.role !== "toolResult" ||
        message.toolName !== "collapse" || message.isError !== false) continue;
    const details = message.details as Record<string, unknown> | undefined;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const pair = { call, caller, result };
    if (call.arguments.action === "inspect" && details.collapseInspection === true) {
      inspections.push(pair);
      continue;
    }
    if (call.arguments.action !== undefined && call.arguments.action !== "collapse") continue;
    const op = typeof details.id === "string" ? committed.get(details.id) : undefined;
    if (!op || call.arguments.summary !== op.summary || typeof call.arguments.startMatch !== "string" ||
        !call.arguments.startMatch || typeof call.arguments.endMatch !== "string" || !call.arguments.endMatch ||
        (details.originalCount !== undefined && details.originalCount !== op.originalCount)) continue;
    mutations.set(op.id, [...(mutations.get(op.id) ?? []), pair]);
  }
  // Conflicting results claiming the same operation are not trustworthy bookkeeping.
  const completed = [...mutations.values()].flatMap(pairs => pairs.length === 1 ? pairs : []);
  // Journal opt-in preserves replay of older selections made without receipts.
  const receipts = new Map([...mutations].flatMap(([id, pairs]) =>
    pairs.length === 1 && committed.get(id)?.receipt ? [[pairs[0].call.id, completionReceipt(id)] as const] : []));
  const latestCaller = completed.reduce((latest, pair) => Math.max(latest, pair.caller), -1);
  // A lookup must survive the next request so the model can use its references.
  // It becomes housekeeping only after a later successful mutation consumes it.
  const hidden = [...completed, ...inspections.filter(pair => pair.result < latestCaller)];
  if (!hidden.length) return rows;
  const hiddenCalls = new Set(hidden.map(pair => pair.call.id));
  const hiddenResults = new Set(hidden.map(pair => pair.result));
  return rows.flatMap((row, index) => {
    if (hiddenResults.has(index)) return [];
    if (row.message.role !== "assistant") return [row];
    if (!row.message.content.some(block => block.type === "toolCall" && hiddenCalls.has(block.id))) return [row];
    // Replace at the caller, not with a user/custom row amid sibling tool results.
    // The receipt carries no summary or arguments and keeps the original audit key.
    const content = row.message.content.flatMap((block): Assistant["content"] => {
      if (block.type !== "toolCall" || !hiddenCalls.has(block.id)) return [block];
      const text = receipts.get(block.id);
      return text ? [{ type: "text", text }] : [];
    });
    return content.length ? [{ ...row, auditMessage: row.auditMessage ?? row.message, message: { ...row.message, content } }] : [];
  });
}

/** Replay old selections against their original view, and new selections against
 * the cleaned view they actually selected. Identify BEFORE removing bookkeeping:
 * occurrence keys and archive provenance must retain their audit identities. */
export function projectHistory(messages: Message[], operations: Collapse[]): Row[] {
  let rows = identify(messages);
  const applied: Collapse[] = [];
  for (const op of operations) {
    if (op.hideBookkeeping) rows = hideBookkeeping(rows, applied);
    rows = apply(rows, op);
    applied.push(op);
  }
  return hideBookkeeping(rows, applied);
}

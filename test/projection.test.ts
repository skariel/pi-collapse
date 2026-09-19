import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundary, expandRange, identify, project, summaryRow, validateCollapse, type Collapse, type Message, type Row } from "../src/core.ts";
import { completionReceipt, hideBookkeeping, projectHistory } from "../src/projection.ts";
import { Storage } from "../src/storage.ts";

type Assistant = Extract<Message, { role: "assistant" }>;
type Call = Extract<Assistant["content"][number], { type: "toolCall" }>;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (content: string, timestamp = 1): Message => ({ role: "user", content, timestamp });
const assistant = (content: Assistant["content"], timestamp = 2): Assistant => ({ role: "assistant", content,
  timestamp, api: "openai-responses", provider: "openai", model: "test", stopReason: "toolUse", usage });
const call = (op: Collapse, id = "collapse-call"): Call => ({ type: "toolCall", id, name: "collapse",
  arguments: { startMatch: "source", endMatch: "source", summary: op.summary } });
const result = (op: Collapse, id = "collapse-call"): Extract<Message, { role: "toolResult" }> => ({
  role: "toolResult", toolCallId: id, toolName: "collapse", content: [{ type: "text", text: `Archived ${op.id}` }],
  isError: false, details: { id: op.id, originalCount: op.originalCount }, timestamp: 3,
});
const operation = (rows: Row[], summary = "summary", hide = true): Collapse => ({ version: 1, identityVersion: 2,
  ...(hide ? { hideBookkeeping: true as const } : {}), id: randomUUID(), keys: rows.map(row => row.key), summary,
  timestamp: 10, originalCount: rows.reduce((sum, row) => sum + (row.originalCount ?? 1), 0),
  supersedes: rows.flatMap(row => row.collapseId ? [row.collapseId] : []),
});

for (const summary of ["Retained decision", ""]) test(`successful ${summary ? "summary" : "removal"} calls/results leave projection, never audit`, () => {
  const source = user("source"), tail = user("continue", 4);
  const op = operation(identify([source]), summary);
  const messages = [source, assistant([call(op)]), result(op), tail];
  const original = structuredClone(messages);
  const rows = projectHistory(messages, [op]);
  assert.deepEqual(rows.map(row => row.message), [...(summary ? [summaryRow(op).message] : []), tail]);
  assert.deepEqual(messages, original);
  assert.deepEqual(projectHistory(JSON.parse(JSON.stringify(messages)), [validateCollapse(op)]), rows,
    "Persistence/reopen has the same cleaned view");
});

test("mixed assistant rows preserve text, thinking and every ordinary tool pair with stable audit identity", () => {
  const source = user("source"), op = operation(identify([source]));
  const ordinary: Call = { type: "toolCall", id: "ordinary", name: "bash", arguments: { command: "pwd" } };
  const output: Message = { ...result(op, ordinary.id), toolName: "bash", details: undefined };
  const message = assistant([{ type: "text", text: "Useful explanation" }, call(op),
    { type: "thinking", thinking: "Useful reasoning" }, ordinary]);
  const messages = [source, message, result(op), output];
  const raw = identify(messages), rows = projectHistory(messages, [op]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].key, raw[1].key);
  assert.equal(boundary(rows[1]), boundary(raw[1]));
  assert.deepEqual(rows[1].originals, raw[1].originals);
  assert.equal(rows[1].auditMessage, message);
  assert.deepEqual(rows[1].message, { ...message, content: message.content.filter(block => block !== message.content[1]) });
  assert.deepEqual(expandRange(rows, 2, 2), [1, 2], "Ordinary result still expands to its caller");
  assert.deepEqual(hideBookkeeping(rows, [op]), rows, "Cleaning is idempotent");
});

test("a successful sibling disappears while a failed collapse sibling and its feedback remain", () => {
  const source = user("source"), op = operation(identify([source]));
  const failed = { ...result(op, "failed"), isError: true, content: [{ type: "text" as const, text: "Use this reference to retry" }] };
  const rows = projectHistory([source, assistant([call(op), call(op, "failed")]), result(op), failed], [op]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].message.role, "assistant");
  if (rows[1].message.role === "assistant") assert.deepEqual(rows[1].message.content, [call(op, "failed")]);
  assert.equal(rows[2].message, failed);
  assert.deepEqual(expandRange(rows, 2, 2), [1, 2]);
});

test("incomplete, ambiguous, stale and mismatched successful-looking bookkeeping is not removed or given receipts", () => {
  const op: Collapse = { ...operation(identify([user("source")])), receipt: true };
  const validCall = assistant([call(op)]), validResult = result(op);
  const variants: Message[][] = [
    [validCall], [validResult], [validResult, validCall],
    [validCall, validCall, validResult], [validCall, validResult, validResult],
    [assistant([{ ...call(op), name: "other" }]), validResult],
    [validCall, { ...validResult, toolName: "other" }],
    [validCall, { ...validResult, isError: true }],
    [validCall, { ...validResult, details: { id: randomUUID() } }],
    [validCall, { ...validResult, details: { id: op.id, originalCount: 99 } }],
    [validCall, { ...validResult, details: undefined }],
    [assistant([{ ...call(op), arguments: { ...call(op).arguments, summary: "different" } }]), validResult],
    [assistant([{ ...call(op), arguments: { ...call(op).arguments, action: "inspect" } }]), validResult],
    [validCall, validResult, assistant([call(op, "duplicate-operation")], 5), result(op, "duplicate-operation")],
  ];
  for (const messages of variants) {
    const rows = identify(messages);
    assert.deepEqual(hideBookkeeping(rows, [op]), rows);
  }
  const rows = identify([validCall, validResult]);
  assert.deepEqual(hideBookkeeping(rows, []), rows, "Uncommitted results never prove a collapse occurred");
});

test("legacy operations selecting earlier bookkeeping replay before cleanup", () => {
  const source = user("source"), first = operation(identify([source]), "first", false);
  const messages = [source, assistant([call(first)]), result(first), user("tail", 4)];
  const oldView = project(messages, [first]);
  const second = operation(oldView, "legacy combined", false);
  assert.ok(second.keys.includes(identify(messages)[1].key));
  assert.deepEqual(projectHistory(messages, [first, second]).map(row => row.message), [summaryRow(second).message]);
  // The old journal itself remains unchanged and still uses its original interpretation.
  assert.equal(first.hideBookkeeping, undefined);
  assert.equal(second.hideBookkeeping, undefined);
});

test("new operations span hidden interior gaps and replay nested replacements/removals", () => {
  for (const firstSummary of ["first", ""]) for (const secondSummary of ["second", ""]) {
    const messages: Message[] = [user("prefix", 0), user("source", 1)];
    const first = operation(identify(messages).slice(1), firstSummary);
    messages.push(assistant([call(first)]), result(first), user("tail", 4));
    const selected = projectHistory(messages, [first]);
    const second = operation(selected, secondSummary);
    messages.push(assistant([call(second, "second-call")], 5), result(second, "second-call"));
    const rows = projectHistory(messages, [first, second]);
    assert.deepEqual(rows.map(row => row.message), secondSummary ? [summaryRow(second).message] : []);
    assert.deepEqual(projectHistory(JSON.parse(JSON.stringify(messages)), [first, second]), rows);
  }
});

test("parallel successful collapse calls disappear only when their own operations are committed", () => {
  const source = [user("first", 1), user("second", 2)];
  const first = operation(identify(source).slice(0, 1), "first done");
  const second = operation(identify(source).slice(1), "second done");
  const messages = [...source, assistant([call(first, "first"), call(second, "second")], 3), result(first, "first"), result(second, "second")];
  const partial = projectHistory(messages, [first]);
  assert.equal(partial.length, 4);
  assert.equal(partial[2].message.role, "assistant");
  if (partial[2].message.role === "assistant") assert.deepEqual(partial[2].message.content, [call(second, "second")]);
  assert.deepEqual(projectHistory(messages, [first, second]).map(row => row.message), [summaryRow(first).message, summaryRow(second).message]);
});

test("lookup feedback survives until a later successful committed collapse, including same-batch lookups", () => {
  const source = user("source"), op = operation(identify([source]));
  const inspection: Call = { type: "toolCall", id: "lookup", name: "collapse", arguments: { action: "inspect", query: "source" } };
  const lookupResult: Message = { ...result(op, "lookup"), details: { collapseInspection: true }, content: [{ type: "text", text: "References" }] };
  const inspectionMessages = [assistant([inspection]), lookupResult];
  assert.deepEqual(projectHistory([source, ...inspectionMessages], []).map(row => row.message), [source, ...inspectionMessages]);
  const messages = [source, ...inspectionMessages, assistant([call(op)], 4), result(op)];
  assert.deepEqual(projectHistory(messages, [op]).map(row => row.message), [summaryRow(op).message]);
  const sameBatch = [source, assistant([inspection, call(op)]), lookupResult, result(op)];
  const rows = projectHistory(sameBatch, [op]);
  assert.equal(rows.length, 3, "A lookup returned in the same batch has not yet been consumed");
  assert.equal(rows[2].message, lookupResult);
  assert.deepEqual(expandRange(rows, 2, 2), [1, 2]);
});

test("archives keep exact mixed audit originals and validate them through nested flattening", async t => {
  const dir = await mkdtemp(join(tmpdir(), "collapse-projection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new Storage(dir);
  const source = user("source"), first = operation(identify([source]), "first");
  await storage.archive(first.id, [source]);
  const message = assistant([{ type: "text", text: "Ordinary result to preserve" }, call(first)]);
  const messages = [source, message, result(first), user("tail", 4)];
  const selected = projectHistory(messages, [first]);
  const originals = await storage.flatten(selected);
  assert.deepEqual(originals, [source, message, messages[3]], "Archives store the full selected audit messages, not rewritten assistant content");
  const second = operation(selected, "second");
  await storage.archive(second.id, originals);
  const projected = projectHistory(messages, [first, second]);
  assert.deepEqual(await storage.flatten(projected), originals);
  const third = operation(projected, "third");
  await storage.archive(third.id, await storage.flatten(projected));
  assert.deepEqual(await storage.flatten(projectHistory(messages, [first, second, third])), originals);
  const changed = structuredClone(originals);
  if (changed[1].role === "assistant") changed[1].content = [{ type: "text", text: "tampered" }];
  await writeFile(storage.path(second.id), changed.map(item => JSON.stringify(item)).join("\n") + "\n");
  await assert.rejects(storage.flatten(projected), /Archive integrity check failed/);
});

for (const summary of ["Unique retained decision", ""]) test(`completion receipts survive ${summary ? "summary" : "removal"} projection and reopen without duplicated content`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "collapse-receipt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new Storage(dir);
  const source = user("source"), request = user("collapse some messages", 2);
  const op: Collapse = { ...operation(identify([source]), summary), receipt: true };
  const caller = assistant([call(op)], 3);
  const messages = [source, request, caller, result(op)];
  const raw = structuredClone(messages);
  const rows = projectHistory(messages, [op]);
  const receipt = rows.at(-1)!;
  assert.equal(receipt.message.role, "assistant");
  if (receipt.message.role === "assistant") {
    assert.deepEqual(receipt.message.content, [{ type: "text", text: completionReceipt(op.id) }]);
  }
  assert.equal(rows.at(-2)!.message, request, "Completion evidence follows the user's request");
  assert.equal(receipt.key, identify(messages)[2].key);
  assert.equal(receipt.auditMessage, caller);
  assert.deepEqual(await storage.flatten([receipt]), [caller], "Receipt archives retain exact audit provenance");
  assert.deepEqual(hideBookkeeping(rows, [op]), rows, "No duplicate receipts on reprojection");
  assert.deepEqual(projectHistory(JSON.parse(JSON.stringify(messages)), [validateCollapse(op)]), rows);
  assert.deepEqual(messages, raw);

  await storage.archive(op.id, [source]);
  const next: Collapse = { ...operation(rows, "Combined"), receipt: true };
  const originals = await storage.flatten(rows);
  await storage.archive(next.id, originals);
  messages.push(assistant([call(next, "next")], 5), result(next, "next"));
  const nested = projectHistory(messages, [op, next]);
  assert.equal(nested.length, 2);
  assert.deepEqual(await storage.flatten(nested.slice(0, 1)), originals);
  assert.ok(!JSON.stringify(nested.map(row => row.message)).includes(completionReceipt(op.id)), "A later collapse can consume earlier receipts");
});

test("receipt-enabled operations replay after historical receipt-free selections", () => {
  const source = user("source"), first = operation(identify([source]), "first");
  const messages = [source, assistant([call(first)]), result(first), user("tail", 4)];
  const second = operation(projectHistory(messages, [first]), "second");
  messages.push(assistant([call(second, "second")], 5), result(second, "second"));
  const third: Collapse = { ...operation(projectHistory(messages, [first, second]), "third"), receipt: true };
  messages.push(assistant([call(third, "third")], 6), result(third, "third"));
  const rows = projectHistory(messages, [first, second, third]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].collapseId, third.id);
  assert.deepEqual(projectHistory(JSON.parse(JSON.stringify(messages)), [first, second, third].map(validateCollapse)), rows);
});

test("parallel committed operations each retain a receipt in their shared caller", () => {
  const source = [user("first"), user("second", 2)];
  const first: Collapse = { ...operation(identify(source).slice(0, 1)), receipt: true };
  const second: Collapse = { ...operation(identify(source).slice(1)), receipt: true };
  const messages = [...source, assistant([call(first, "first"), call(second, "second")]), result(first, "first"), result(second, "second")];
  const rows = projectHistory(messages, [first, second]);
  const receipt = rows[2].message;
  assert.equal(receipt.role, "assistant");
  if (receipt.role === "assistant") assert.deepEqual(receipt.content, [first, second].map(op => ({ type: "text", text: completionReceipt(op.id) })));
  assert.equal(rows.length, 3);
});

test("bookkeeping projection version is explicit and validated", () => {
  const op = operation(identify([user("source")]));
  assert.equal(validateCollapse(op).hideBookkeeping, true);
  assert.equal(validateCollapse({ ...op, receipt: true }).receipt, true);
  for (const receipt of [false, 1, "true", null]) {
    assert.throws(() => validateCollapse({ ...op, receipt }), /Invalid collapse journal entry/);
  }
  assert.throws(() => validateCollapse({ ...op, receipt: true, hideBookkeeping: undefined }), /Invalid collapse journal entry/);
  assert.equal(validateCollapse({ ...op, hideBookkeeping: undefined }).hideBookkeeping, undefined);
  for (const hideBookkeeping of [false, 1, "true", null]) {
    assert.throws(() => validateCollapse({ ...op, hideBookkeeping }), /Invalid collapse journal entry/);
  }
});

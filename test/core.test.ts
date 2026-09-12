import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, boundary, eligibleRanges, DEFAULT_CONFIG, expandRange, identify, matchMessage, nextForced, project, selectRange, summaryRow, validateCollapse, validateConfig, type Collapse, type Message } from "../src/core.ts";
import { Storage } from "../src/storage.ts";

export const user = (content: string, timestamp = 1): Message => ({ role: "user", content, timestamp });
const assistant = (ids: string[]): Message => ({ role: "assistant", content: ids.map(id => ({ type: "toolCall", name: "bash", id, arguments: { command: id } })), timestamp: 2, api: "openai-responses", provider: "openai", model: "test", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: `output-${id}` }], isError: false, timestamp: 3 });
const operation = (rows: ReturnType<typeof identify>, summary = "summary"): Collapse => ({ version: 1, id: randomUUID(), keys: rows.map(r => r.key), summary, timestamp: 10, originalCount: rows.length, supersedes: [] });

test("literal matching: case, spaces, decoded newlines, JSON and repeated occurrences within one message", () => {
  const rows = identify([user("A  B\nC A  B"), user("a b"), assistant(["xyz"])]);
  assert.equal(matchMessage(rows, "A  B\nC", "start"), 0);
  assert.equal(matchMessage(rows, "A  B", "start"), 0);
  assert.equal(matchMessage(rows, '"command":"xyz"', "end"), 2);
  assert.throws(() => matchMessage(rows, "A B", "start"), /not found.*case-/s);
  assert.throws(() => matchMessage(rows, "A  b", "start"), /Closest candidates/);
  assert.throws(() => matchMessage(rows, "", "start"), /empty/);
});

test("ambiguous matches never select, suggestions are bounded", () => {
  const rows = identify([user("hello"), user("hello", 2), user("x".repeat(100_000))]);
  assert.throws(() => matchMessage(rows, "hello", "end"), /ambiguous; matches messages 1, 2/);
  try { matchMessage(rows, "missing", "end"); } catch (error) { assert.ok(String(error).length < 1500); }
});

test("inclusive ranges expand to all sibling tool results, both boundaries", () => {
  const rows = identify([user("before"), assistant(["a", "b"]), result("a"), result("b"), user("after")]);
  assert.deepEqual(expandRange(rows, 2, 2), [1, 3]);
  assert.deepEqual(expandRange(rows, 0, 1), [0, 3]);
  assert.deepEqual(expandRange(rows, 3, 4), [1, 4]);
  assert.deepEqual(selectRange(rows, "output-a", "output-a", 1), [1, 3]);
  assert.throws(() => selectRange(rows, "output-a", "output-a", 2), /protected/);
  assert.throws(() => selectRange(rows, "after", "before", 0), /precede/);
});

test("incomplete and duplicate tool groups cannot be selected", () => {
  assert.throws(() => expandRange(identify([assistant(["a"])]), 0, 0), /incomplete/);
  assert.throws(() => expandRange(identify([result("a")]), 0, 0), /incomplete/);
  assert.throws(() => expandRange(identify([assistant(["a"]), result("a"), result("a")]), 0, 0), /ambiguous/);
});

test("replay is deterministic across clones, rejects altered/noncontiguous history", () => {
  const messages = [user("first"), user("second"), user("third")];
  const op = operation(identify(messages).slice(0, 2));
  assert.deepEqual(project(structuredClone(messages), [op]), [summaryRow(op), identify(messages)[2]]);
  assert.throws(() => project([messages[0], user("insertion"), ...messages.slice(1)], [op]), /history changed/);
  assert.throws(() => project([user("different"), ...messages.slice(1)], [op]), /history changed/);
  const duplicates = identify([messages[0], messages[0]]);
  assert.notEqual(duplicates[0].key, duplicates[1].key);
  assert.equal(identify([{ timestamp: 1, content: "first", role: "user" }])[0].key, identify(messages)[0].key);
});

test("empty-summary replay removes complete groups and can remove all remaining history", () => {
  const messages = [user("before"), assistant(["a", "b"]), result("a"), result("b"), user("after")];
  const rows = identify(messages);
  const [start, end] = selectRange(rows, "output-a", "output-a", 1);
  const removal = validateCollapse(operation(rows.slice(start, end + 1), ""));
  const remaining = project(messages, [removal]);
  assert.deepEqual(remaining, [rows[0], rows[4]]);
  const final = validateCollapse(operation(remaining, ""));
  assert.deepEqual(project(messages, [removal, final]), []);
  assert.throws(() => validateCollapse({ ...removal, summary: "   " }), /Invalid/);
  assert.throws(() => project([user("changed"), ...messages.slice(1)], [removal, final]), /history changed/);
});

test("identity boundaries ignore echoed references and never retarget superseded summaries", () => {
  const original = identify([user("original")]);
  const op = operation(original);
  const summary = summaryRow(op);
  const ref = boundary(summary);
  const ordinary = identify([user(`echo ${ref} ${op.id}`)])[0];
  const rows = [summary, ordinary];
  assert.throws(() => matchMessage(rows, op.id, "start"), /ambiguous/);
  assert.equal(matchMessage(rows, ref, "start"), 0);
  assert.equal(matchMessage(rows, boundary(ordinary), "start"), 1);
  const next = operation([summary], "updated");
  assert.throws(() => matchMessage(apply(rows, next), ref, "start"), /not found/);
  assert.throws(() => matchMessage(apply(rows, { ...next, summary: "" }), ref, "start"), /not found/);
});

test("protection failures suggest only bounded complete eligible ranges with usable references", () => {
  const rows = identify([user("old"), assistant(["a", "b"]), result("a"), result("b"), user("new")]);
  const hints = eligibleRanges(rows, 1);
  const suggestions = hints.split("\n").slice(1).map(line => JSON.parse(line.slice(line.indexOf("{"))));
  assert.equal(suggestions.length, 2);
  for (const s of suggestions) assert.ok(selectRange(rows, s.startMatch, s.endMatch, 1)[1] < 4);
  assert.match(eligibleRanges(rows, 2), /messages 1–1/);
  assert.ok(!eligibleRanges(rows, 2).includes(boundary(rows[1])));
  assert.match(eligibleRanges(rows, rows.length), /No eligible/);
  assert.match(eligibleRanges(identify([assistant(["pending"])]), 0), /No eligible/);
  assert.throws(() => selectRange(rows, "new", "new", 1), /Eligible complete ranges/);
  assert.ok(eligibleRanges(identify(Array.from({ length: 20 }, (_, i) => user(String(i)))), 1).split("\n").length <= 4);
});

test("threshold hysteresis and strict configuration validation", () => {
  assert.equal(nextForced(false, 84.9, DEFAULT_CONFIG), false);
  assert.equal(nextForced(false, 85, DEFAULT_CONFIG), true);
  assert.equal(nextForced(true, 60, DEFAULT_CONFIG), true);
  assert.equal(nextForced(true, 50, DEFAULT_CONFIG), false);
  for (const config of [{ ...DEFAULT_CONFIG, targetPercent: 86 }, { ...DEFAULT_CONFIG, protectRecent: -1 },
    { ...DEFAULT_CONFIG, protectRecent: 1.5 }, { ...DEFAULT_CONFIG, triggerPercent: NaN }, { ...DEFAULT_CONFIG, extra: 1 }]) {
    assert.throws(() => validateConfig(config));
  }
});

test("nested/mixed archives flatten chronologically, retain old files for branches, private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-collapse-test-"));
  try {
    const storage = new Storage(join(dir, "archives"));
    const messages = [user("first"), user("second"), user("third"), user("fourth")];
    const rows = identify(messages);
    const a = operation(rows.slice(0, 2), "old summary should disappear");
    await storage.archive(a.id, messages.slice(0, 2));
    const b = operation(rows.slice(3), "another summary");
    await storage.archive(b.id, messages.slice(3));
    const mixed = apply(apply(rows, a), b);
    const flat = await storage.flatten(mixed);
    assert.deepEqual(flat, messages);
    const c = operation(mixed, "new summary");
    await storage.archive(c.id, flat);
    assert.deepEqual(await storage.originals(c.id), messages);
    assert.deepEqual(await storage.originals(a.id), messages.slice(0, 2));
    assert.ok(!(await readFile(storage.path(c.id), "utf8")).includes("old summary"));
    assert.equal((await stat(storage.path(c.id))).mode & 0o777, 0o600);
    assert.equal((await stat(storage.directory)).mode & 0o777, 0o700);
    assert.throws(() => storage.path("../../bad"), /Invalid/);
    await assert.rejects(storage.flatten([{ ...rows[0], collapseId: randomUUID() }]), /ENOENT/);
    assert.deepEqual(await storage.config(), DEFAULT_CONFIG);
    await storage.saveConfig({ ...DEFAULT_CONFIG, protectRecent: 3 });
    assert.equal((await storage.config()).protectRecent, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

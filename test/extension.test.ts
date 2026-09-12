import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { description, registerCollapse } from "../src/index.ts";
import { Storage } from "../src/storage.ts";
import { CONFIG_TYPE, FORCE_TYPE, OP_TYPE, type Message } from "../src/core.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (content: string, timestamp = 1): Message => ({ role: "user", content, timestamp });
const assistant = (content: any[] = [{ type: "text", text: "done" }]): Message => ({ role: "assistant", content, api: "openai-responses", provider: "openai", model: "test", timestamp: 99, usage, stopReason: "stop" });

function harness(sm: SessionManager, storage: Storage, window = 100_000) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>([["read", { name: "read", description: "Read", parameters: {} }], ["bash", { name: "bash", description: "Bash", parameters: {} }]]);
  let active = ["read", "bash", "collapse"];
  const notifications: string[] = [], sent: any[] = [];
  const statuses = new Map<string, string>();
  let aborted = false;
  const pi = {
    on(name: string, callback: Function) { handlers.set(name, callback); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = [...names]; },
    getAllTools: () => [...tools.values()],
    appendEntry: (name: string, data: unknown) => { sm.appendCustomEntry(name, data); },
    sendMessage: (message: any) => sent.push(message),
  };
  const ctx = {
    sessionManager: sm, model: { api: "openai-responses", contextWindow: window }, mode: "rpc", hasUI: true,
    getSystemPrompt: () => "System instructions", getContextUsage: () => ({ tokens: 99_999, percent: 99.9, contextWindow: window }),
    ui: { notify: (text: string) => notifications.push(text), setStatus: (key: string, text: string) => statuses.set(key, text) },
    abort: () => { aborted = true; }, waitForIdle: async () => {},
  };
  registerCollapse(pi as unknown as ExtensionAPI, storage);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  const context = () => emit("context", { messages: sm.buildSessionContext().messages });
  const collapse = (startMatch: string, endMatch: string, summary = "Completed task; tests passed.", signal?: AbortSignal) =>
    tools.get("collapse").execute("current-call", { startMatch, endMatch, summary }, signal, undefined, ctx);
  return { emit, context, collapse, commands, notifications, sent, statuses, ctx, active: () => active, aborted: () => aborted };
}

async function fixture(t: any, messages: Message[], config = { protectRecent: 0 }, window?: number, persist = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-collapse-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new Storage(join(dir, "archives"));
  const sm = persist ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
  for (const message of messages) {
    if (message.role === "branchSummary" || message.role === "compactionSummary") throw new Error("Use summary entries in fixtures");
    sm.appendMessage(message);
  }
  sm.appendCustomEntry(CONFIG_TYPE, { triggerPercent: 85, targetPercent: 50, ...config });
  const h = harness(sm, storage, window);
  await h.emit("session_start");
  return { ...h, sm, storage, dir };
}

test("guidance prioritizes dependencies and useful cleanup without weakening forced-mode instructions", async t => {
  const text = description("/test/archives");
  assert.match(text, /current user constraints, unresolved tasks, unmet acceptance criteria/);
  assert.match(text, /completion certainty first.*lower dependency risk.*older age.*larger expected savings/);
  assert.match(text, /Outside forced mode, skip tiny/);
  assert.match(text, /Prefer outcomes over chronology/);
  assert.match(text, /At that point, X was unimplemented/);
  assert.match(text, /Forced mode always requires shrinking/);
  const f = await fixture(t, [user("hello")]);
  const start = await f.emit("before_agent_start", { systemPrompt: "Base policy" });
  assert.ok(start.systemPrompt.startsWith("Base policy"));
  assert.match(start.systemPrompt, /preserving active dependencies/);
  assert.match(start.systemPrompt, /then call only collapse/);
  assert.ok(!start.systemPrompt.includes("FORCED COLLAPSE MODE"));
});

test("journal replacement survives actual SessionManager save/open, branching and extension reload", async t => {
  const f = await fixture(t, [user("START " + "x".repeat(1500)), user("END " + "y".repeat(1500)), assistant()], undefined, undefined, true);
  const originalLeaf = f.sm.getLeafId()!;
  await f.context();
  const result = await f.collapse("START", "END");
  const collapsedLeaf = f.sm.getLeafId()!;
  const projection = await f.context();
  assert.equal(projection.messages.length, 2);
  assert.match(projection.messages[0].content, /Completed task/);
  assert.ok(!JSON.stringify(projection.messages).includes("x".repeat(100)));
  assert.equal((await f.storage.originals(result.details.id)).length, 2);
  const reopened = SessionManager.open(f.sm.getSessionFile()!);
  const resumed = harness(reopened, f.storage);
  await resumed.emit("session_start");
  assert.equal(resumed.statuses.get("collapse"), "collapse 2 messages | 1 archive");
  assert.deepEqual((await resumed.context()).messages, projection.messages);
  f.sm.branch(originalLeaf);
  await f.emit("session_tree");
  assert.equal((await f.context()).messages.length, 3);
  assert.equal(f.statuses.get("collapse"), "collapse 0 messages | 0 archives");
  f.sm.branch(collapsedLeaf);
  await f.emit("session_tree");
  assert.deepEqual((await f.context()).messages, projection.messages);
  await f.commands.get("collapse").handler("list", f.ctx);
  assert.ok(f.notifications.at(-1)?.includes(result.details.id));
});

test("forced request: only collapse payload/execution, ignores stale raw context usage, exits below target", async t => {
  const f = await fixture(t, [user("LARGE_TASK " + "x".repeat(20_000)), user("latest")], { protectRecent: 10 }, 6000);
  await f.context();
  assert.deepEqual(f.active(), ["collapse"]);
  assert.equal(f.statuses.get("collapse"), "COLLAPSE ONLY 0 messages | 0 archives");
  assert.equal((await f.emit("tool_call", { toolName: "read" })).block, true);
  const payload = await f.emit("before_provider_request", { payload: { model: "test", input: [] } });
  assert.deepEqual(payload.tools.map((v: any) => v.name), ["collapse"]);
  assert.deepEqual(payload.tool_choice, { type: "function", name: "collapse" });
  const result = await f.collapse("LARGE_TASK", "LARGE_TASK");
  assert.match(result.content[0].text, /protection waived/);
  await f.context();
  assert.deepEqual(f.active(), ["read", "bash", "collapse"]);
  assert.equal(f.statuses.get("collapse"), "collapse 1 message | 1 archive");
  assert.equal(await f.emit("tool_call", { toolName: "read" }), undefined);
  const states = f.sm.getBranch().filter(e => e.type === "custom" && e.customType === FORCE_TYPE).map(e => (e as any).data);
  assert.deepEqual(states, [true, false]);
});

test("forced mode never deadlocks a valid selected range behind unrelated protected-tail candidates", async t => {
  const messages = [
    user("OLD_LARGE_A " + "a".repeat(7000), 1),
    user("OLD_LARGE_B " + "b".repeat(7000), 2),
    user("OLD_ELIGIBLE " + "c".repeat(1000), 3),
    ...Array.from({ length: 10 }, (_, i) => user(`RECENT_${i} ` + "r".repeat(80), 10 + i)),
  ];
  const f = await fixture(t, messages, { protectRecent: 10 }, 6000);
  await f.context();
  assert.deepEqual(f.active(), ["collapse"]);
  // The old policy rejected this because OLD_ELIGIBLE was independently
  // collapsible and the protected tail alone was below the target.
  const result = await f.collapse("OLD_LARGE_A", "RECENT_0", "Completed coherent historical work.");
  assert.match(result.content[0].text, /protection waived/);
  assert.equal((await f.context()).messages.length, 10);
});

test("normal recent protection, summary reduction, exact matching, no side effects on rejection", async t => {
  const f = await fixture(t, [user("OLD " + "x".repeat(1000)), user("RECENT " + "y".repeat(1000))], { protectRecent: 1 });
  await f.context();
  await assert.rejects(f.collapse("RECENT", "RECENT"), /protected/);
  await assert.rejects(f.collapse("old", "OLD"), /not found/);
  await assert.rejects(f.collapse("OLD", "OLD", "huge".repeat(1000)), /shorter/);
  assert.equal(f.sm.getBranch().filter(e => e.type === "custom" && e.customType === OP_TYPE).length, 0);
});

test("concurrent tool calls serialize; recollapse combines summaries and ordinary messages", async t => {
  const f = await fixture(t, [user("A_BEGIN " + "a".repeat(1000)), user("B_BEGIN " + "b".repeat(1000)), user("C_BEGIN " + "c".repeat(1000))]);
  await f.context();
  const [a, b] = await Promise.all([f.collapse("A_BEGIN", "A_BEGIN", "Task A complete"), f.collapse("B_BEGIN", "B_BEGIN", "Task B complete")]);
  assert.equal(f.statuses.get("collapse"), "collapse 2 messages | 2 archives");
  const c = await f.collapse(a.details.id, "C_BEGIN", "Three tasks complete");
  assert.equal(f.statuses.get("collapse"), "collapse 3 messages | 1 archive");
  assert.equal((await f.context()).messages.length, 1);
  const originals = await f.storage.originals(c.details.id);
  assert.equal(originals.length, 3);
  assert.ok(!JSON.stringify(originals).includes("Task A complete"));
  assert.equal((await f.storage.originals(b.details.id)).length, 1);
});

test("archive failure or cancellation never commits a replacement", async t => {
  const f = await fixture(t, [user("FAIL " + "a".repeat(1000))]);
  await f.context();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.collapse("FAIL", "FAIL", "summary", controller.signal), /cancelled/);
  f.storage.archive = async () => { throw new Error("disk full"); };
  await assert.rejects(f.collapse("FAIL", "FAIL"), /disk full/);
  assert.equal((await f.context()).messages.length, 1);
  assert.equal(f.sm.getBranch().filter(e => e.type === "custom" && e.customType === OP_TYPE).length, 0);
});

test("native compaction/branch summarization are blocked; configuration validated and persisted", async t => {
  const f = await fixture(t, [user("hi")]);
  assert.deepEqual(await f.emit("session_before_compact"), { cancel: true });
  assert.deepEqual(await f.emit("session_before_tree", { preparation: { userWantsSummary: true } }), { cancel: true });
  assert.equal(await f.emit("session_before_tree", { preparation: { userWantsSummary: false } }), undefined);
  await f.commands.get("collapse").handler('config session {"triggerPercent":90}', f.ctx);
  assert.match(f.notifications.at(-1)!, /"triggerPercent":90/);
  await f.commands.get("collapse").handler('config session {"targetPercent":99}', f.ctx);
  assert.match(f.notifications.at(-1)!, /Require/);
  await f.commands.get("collapse").handler('config global {"protectRecent":5}', f.ctx);
  assert.equal((await f.storage.config()).protectRecent, 5);
  await f.commands.get("collapse").handler("config reset", f.ctx);
  assert.match(f.notifications.at(-1)!, /"protectRecent":5/);
});

test("forced plain answers are removed and retried only five times; shutdown restores tools", async t => {
  const f = await fixture(t, [user("HUGE " + "x".repeat(20_000))], undefined, 6000);
  await f.context();
  for (let i = 0; i < 5; i++) {
    const replaced = await f.emit("message_end", { message: assistant() });
    assert.deepEqual(replaced.message.content, []);
    await f.emit("turn_end", { message: replaced.message, toolResults: [] });
  }
  assert.equal(f.sent.length, 4);
  assert.equal(f.aborted(), true);
  await f.emit("session_shutdown");
  assert.deepEqual(f.active(), ["read", "bash", "collapse"]);
});

test("empty summary removes without a placeholder, remains discoverable, and survives restart/branch changes", async t => {
  const f = await fixture(t, [user("REDUNDANT_LOG"), user("Keep this"), assistant()], undefined, undefined, true);
  const originalLeaf = f.sm.getLeafId()!;
  await f.context();
  await assert.rejects(f.collapse("REDUNDANT_LOG", "REDUNDANT_LOG", "  "), /whitespace/);
  const result = await f.collapse("REDUNDANT_LOG", "REDUNDANT_LOG", "");
  assert.equal(result.details.removed, true);
  assert.match(result.content[0].text, /without a replacement/);
  const projection = await f.context();
  assert.deepEqual(projection.messages, [user("Keep this"), assistant()]);
  assert.deepEqual(await f.storage.originals(result.details.id), [user("REDUNDANT_LOG")]);
  const resumed = harness(SessionManager.open(f.sm.getSessionFile()!), f.storage);
  await resumed.emit("session_start");
  assert.deepEqual((await resumed.context()).messages, projection.messages);
  await resumed.commands.get("collapse").handler("list", resumed.ctx);
  assert.match(resumed.notifications.at(-1)!, /removed without replacement/);
  assert.ok(resumed.notifications.at(-1)!.includes(result.details.id));
  await resumed.commands.get("collapse").handler(`show ${result.details.id}`, resumed.ctx);
  assert.equal(JSON.parse(resumed.notifications.at(-1)!).active, true);
  await resumed.commands.get("collapse").handler("status", resumed.ctx);
  assert.equal(JSON.parse(resumed.notifications.at(-1)!).removedRanges, 1);
  f.sm.branch(originalLeaf);
  await f.emit("session_tree");
  assert.equal((await f.context()).messages.length, 3);
  await f.commands.get("collapse").handler("list", f.ctx);
  assert.match(f.notifications.at(-1)!, /No active collapses/);
});

test("removing an existing summary flattens its originals and does not double-count its archive", async t => {
  const f = await fixture(t, [user("OLD_LOG " + "x".repeat(1500)), user("KEEP")]);
  await f.context();
  const first = await f.collapse("OLD_LOG", "OLD_LOG", "Obsolete task results.");
  const removal = await f.collapse(first.details.id, first.details.id, "");
  assert.deepEqual((await f.context()).messages, [user("KEEP")]);
  assert.deepEqual(await f.storage.originals(removal.details.id), await f.storage.originals(first.details.id));
  await f.commands.get("collapse").handler("list", f.ctx);
  assert.ok(f.notifications.at(-1)!.includes(removal.details.id));
  assert.ok(!f.notifications.at(-1)!.includes(first.details.id));
});

test("empty removals still obey protection and archive-before-commit; independent removals serialize", async t => {
  const f = await fixture(t, [user("REMOVE_A"), user("REMOVE_B"), user("PROTECTED")], { protectRecent: 1 });
  await f.context();
  await assert.rejects(f.collapse("PROTECTED", "PROTECTED", ""), /protected/);
  const archive = f.storage.archive.bind(f.storage);
  f.storage.archive = async () => { throw new Error("disk full"); };
  await assert.rejects(f.collapse("REMOVE_A", "REMOVE_A", ""), /disk full/);
  assert.equal((await f.context()).messages.length, 3);
  f.storage.archive = archive;
  await Promise.all([f.collapse("REMOVE_A", "REMOVE_A", ""), f.collapse("REMOVE_B", "REMOVE_B", "")]);
  assert.deepEqual((await f.context()).messages, [user("PROTECTED")]);
  await f.commands.get("collapse").handler("status", f.ctx);
  assert.equal(JSON.parse(f.notifications.at(-1)!).activeCollapses, 2);
});

test("same-size and bounded growing corrections work only for single summaries outside forced mode", async t => {
  const f = await fixture(t, [user("SOURCE " + "x".repeat(3000))]);
  await f.context();
  const first = await f.collapse("SOURCE", "SOURCE", "Old decision.");
  assert.equal(first.details.boundary, `@collapse:${first.details.id}`);
  const second = await f.collapse(first.details.boundary, first.details.boundary, "New decision.");
  assert.equal(second.details.estimatedRangeTokensSaved, 0);
  const third = await f.collapse(second.details.boundary, second.details.boundary, "New decision; verified.");
  assert.ok(third.details.estimatedRangeTokensSaved < 0);
  await assert.rejects(f.collapse(third.details.boundary, third.details.boundary, "x".repeat(2000)), /growth allowance/);
  await assert.rejects(f.collapse(first.details.boundary, first.details.boundary), /not found/);
  await f.commands.get("collapse").handler("list", f.ctx);
  assert.ok(f.notifications.at(-1)!.includes(third.details.boundary));
  // Same summary is now protected by forced mode's strict shrink requirement.
  f.sm.appendMessage({ role: "user", content: "NEW_LARGE_WORK " + "x".repeat(25_000), timestamp: 2 });
  f.ctx.model.contextWindow = 6000;
  await f.context();
  await assert.rejects(f.collapse(third.details.boundary, third.details.boundary, "New decision; verified."), /shorter/);
});

test("status reports history savings, summarized/removed counts and active archive bytes without double counting", async t => {
  const f = await fixture(t, [user("SUMMARY_A " + "x".repeat(2000)), user("REMOVE_B " + "y".repeat(1000))]);
  await f.context();
  const old = await f.collapse("SUMMARY_A", "SUMMARY_A", "Completed A.");
  const current = await f.collapse(old.details.boundary, old.details.boundary, "Updated A.");
  const removed = await f.collapse("REMOVE_B", "REMOVE_B", "");
  await f.commands.get("collapse").handler("status", f.ctx);
  const status = JSON.parse(f.notifications.at(-1)!);
  assert.equal(status.summarizedMessages, 1);
  assert.equal(status.removedMessages, 1);
  assert.equal(status.activeCollapses, 2);
  assert.equal(status.activeArchiveBytes, (await stat(f.storage.path(current.details.id))).size + (await stat(f.storage.path(removed.details.id))).size);
  assert.deepEqual(status.unavailableArchives, []);
  assert.ok(status.estimatedHistoryTokens.saved > 0);
  assert.equal(status.estimatedHistoryTokens.saved, status.estimatedHistoryTokens.withoutCollapse - status.estimatedHistoryTokens.withCollapse);
  await unlink(f.storage.path(removed.details.id));
  await f.commands.get("collapse").handler("status", f.ctx);
  assert.deepEqual(JSON.parse(f.notifications.at(-1)!).unavailableArchives, [removed.details.id]);
});

test("unsupported forced provider and replay corruption abort instead of exposing full history", async t => {
  const f = await fixture(t, [user("HUGE " + "x".repeat(20_000))], undefined, 6000);
  await f.context();
  f.ctx.model.api = "unsupported";
  assert.deepEqual(await f.emit("before_provider_request", { payload: {} }), {});
  assert.equal(f.aborted(), true);
  assert.deepEqual(await f.context(), { messages: [] });
});

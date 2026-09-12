import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCollapse } from "../src/index.ts";
import { Storage } from "../src/storage.ts";
import { CONFIG_TYPE } from "../src/core.ts";

test("forced mode relaxes protection for a large tool request whose short result is protected", async t => {
  const directory = await mkdtemp(join(tmpdir(), "collapse-crossing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sm = SessionManager.inMemory(directory);
  sm.appendMessage({ role: "user", content: "old", timestamp: 1 });
  sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash", id: "big", arguments: { command: "CROSSING_REQUEST " + "x".repeat(22_000) } }],
    api: "openai-responses", provider: "openai", model: "test", timestamp: 2, stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  sm.appendMessage({ role: "toolResult", toolCallId: "big", toolName: "bash", content: [{ type: "text", text: "short-result" }], isError: false, timestamp: 3 });
  sm.appendCustomEntry(CONFIG_TYPE, { triggerPercent: 85, targetPercent: 50, protectRecent: 1 });
  const events = new Map<string, Function>();
  let collapse: any;
  let active = ["collapse"];
  const pi = {
    on: (name: string, fn: Function) => events.set(name, fn), registerTool: (tool: any) => { collapse = tool; }, registerCommand() {},
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; }, getAllTools: () => [collapse],
    appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
  };
  const ctx = { sessionManager: sm, model: { api: "openai-responses", contextWindow: 6000 }, getSystemPrompt: () => "system",
    ui: { notify() {}, setStatus() {} }, abort() { throw new Error("unexpected abort"); } };
  const storage = new Storage(directory);
  registerCollapse(pi as unknown as ExtensionAPI, storage);
  await events.get("session_start")!({}, ctx);
  await events.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
  const answer = await collapse.execute("call", { startMatch: "CROSSING_REQUEST", endMatch: "short-result", summary: "Large command completed." }, undefined, undefined, ctx);
  assert.match(answer.content[0].text, /protection waived/);
  const originals = await storage.originals(answer.details.id);
  assert.deepEqual(originals.map(m => m.role), ["assistant", "toolResult"]);
});

test("archives cannot be overwritten even when an ID is reused", async t => {
  const directory = await mkdtemp(join(tmpdir(), "collapse-immutable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new Storage(directory);
  const id = "00000000-0000-0000-0000-000000000000";
  await storage.archive(id, [{ role: "user", content: "original", timestamp: 1 }]);
  await assert.rejects(storage.archive(id, [{ role: "user", content: "replacement", timestamp: 2 }]), /EEXIST/);
  assert.equal((await storage.originals(id))[0].role, "user");
  assert.match(JSON.stringify(await storage.originals(id)), /original/);
});

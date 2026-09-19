import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type Context, type ToolCall,
} from "@earendil-works/pi-ai";
import { registerCollapse } from "../src/index.ts";
import { Storage } from "../src/storage.ts";
import { CONFIG_TYPE, FORCE_TYPE, OP_TYPE, validateCollapse } from "../src/core.ts";
import { projectHistory as project } from "../src/projection.ts";
import { UsageMeter } from "../src/usage.ts";

interface Request { context: Context; payload: Record<string, unknown> }
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Real SDK, extension runner and agent loop; only the provider's transport is replaced. */
async function setup(t: TestContext, options: {
  manager?: SessionManager;
  storage?: Storage;
  seed?: (manager: SessionManager) => void;
  inline?: (pi: ExtensionAPI) => void;
  defaultSystemPrompt?: boolean;
  normalGuidelines?: string[];
  compaction?: boolean;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-collapse-real-loop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = options.storage ?? new Storage(join(dir, "archives"));
  const sm = options.manager ?? SessionManager.create(dir, join(dir, "sessions"));
  options.seed?.(sm);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: options.compaction ?? false }, retry: { enabled: false },
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider("collapse-loop-test", {
    baseUrl: "http://127.0.0.1:1/not-used", api: "openai-responses", apiKey: "not-a-real-key",
    models: [{ id: "local", name: "Local mock", reasoning: false, input: ["text"],
      contextWindow: 6000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const model = runtime.getModel("collapse-loop-test", "local");
  assert.ok(model);
  let normalCalls = 0;
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, "agent"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    ...(options.defaultSystemPrompt ? {} : { systemPrompt: "Follow the user's request." }),
    extensionFactories: [pi => {
      registerCollapse(pi, storage);
      pi.registerTool({ name: "normal_action", label: "Normal", description: "Ordinary work",
        promptGuidelines: options.normalGuidelines,
        parameters: Type.Object({}),
        async execute() { normalCalls++; return { content: [{ type: "text", text: "Normal work done" }], details: {} }; },
      });
      options.inline?.(pi);
    }],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: dir, agentDir: join(dir, "agent"), modelRuntime: runtime, model, thinkingLevel: "off",
    settingsManager, sessionManager: sm, resourceLoader: loader, tools: ["collapse", "normal_action"],
  });
  assert.deepEqual(extensionsResult.errors, []);
  const errors: string[] = [];
  await session.bindExtensions({ onError: error => errors.push(error.error) });
  t.after(() => session.dispose());
  const requests: Request[] = [];
  function script(respond: (index: number, request: Request) => AssistantMessage["content"],
    overrides?: (index: number) => Partial<Pick<AssistantMessage, "stopReason" | "usage">>) {
    session.agent.streamFunction = async (selectedModel, context, streamOptions) => {
      // Like real transports, do not start a request after the agent aborts. The loop can
      // invoke streamFunction once more with an already-aborted signal after a tool batch.
      if (streamOptions?.signal?.aborted) {
        const error: AssistantMessage = { role: "assistant", content: [], api: selectedModel.api,
          provider: selectedModel.provider, model: selectedModel.id, timestamp: Date.now(),
          usage: structuredClone(zeroUsage), stopReason: "aborted", errorMessage: "Aborted before transport" };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "error", reason: "aborted", error });
        stream.end(error);
        return stream;
      }
      // Exercise the real before_provider_request chain, without opening an HTTP connection.
      const body = { model: selectedModel.id, input: context.messages,
        tools: (context.tools ?? []).map(tool => ({ type: "function", name: tool.name,
          description: tool.description, parameters: tool.parameters })), tool_choice: "auto" };
      const payload = (await streamOptions?.onPayload?.(body, selectedModel) ?? body) as Record<string, unknown>;
      const request = { context: { ...context, messages: structuredClone(context.messages),
        tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) },
        payload: structuredClone(payload) };
      requests.push(request);
      assert.ok(requests.length <= 70, "The real loop must not continue indefinitely");
      const content = respond(requests.length - 1, request);
      const message: AssistantMessage = { role: "assistant", content, api: selectedModel.api,
        provider: selectedModel.provider, model: selectedModel.id, timestamp: Date.now(), usage: structuredClone(zeroUsage),
        stopReason: content.some(b => b.type === "toolCall") ? "toolUse" : "stop", ...overrides?.(requests.length - 1) };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
      return stream;
    };
  }
  return { session, sm, storage, errors, requests, script, normalCalls: () => normalCalls };
}

function tools(request: Request): string[] {
  return (request.payload.tools as Array<{ name: string }>).map(tool => tool.name);
}
function allText(request: Request): string { return JSON.stringify(request.context.messages); }
function operations(manager: SessionManager) {
  return manager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === OP_TYPE ? [validateCollapse(entry.data)] : []);
}
async function prompt(session: AgentSession, value: string) {
  // A timeout aborts a broken test's real agent loop, rather than leaking it into other tests.
  const timer = setTimeout(() => void session.abort(), 5000);
  try { await session.prompt(value); } finally { clearTimeout(timer); }
}

for (const remove of [false, true]) test(`real agent loop: forced ${remove ? "removal" : "summary"} records request/result, releases normal tools next turn, and survives reopen`, async t => {
  const f = await setup(t, { seed(sm) {
    sm.appendCustomMessageEntry("other-extension", "CUSTOM_TASK " + "x".repeat(22_000), true);
    sm.appendCustomEntry(CONFIG_TYPE, { triggerPercent: 85, targetPercent: 50, protectRecent: 0 });
  } });
  // Live custom messages can predate the custom entry's timestamp (e.g. while queued).
  // The public agent state API makes that real persistence discrepancy deterministic here.
  f.session.agent.state.messages = f.session.messages.map(message => message.role === "custom" ? { ...message, timestamp: 1 } : message);
  const persistedCustom = f.sm.buildSessionContext().messages.find(message => message.role === "custom");
  assert.notEqual(persistedCustom?.timestamp, 1);
  f.script((index, request) => {
    if (index === 0) {
      assert.deepEqual(tools(request), ["collapse"]);
      assert.deepEqual(request.payload.tool_choice, { type: "function", name: "collapse" });
      assert.match(allText(request), /FORCED COLLAPSE MODE/);
      return [call("collapse_1", "collapse", { startMatch: "CUSTOM_TASK", endMatch: "CUSTOM_TASK", summary: remove ? "" : "Custom task finished; preserve its result." })];
    }
    if (index === 1) {
      assert.ok(!allText(request).includes("x".repeat(100)), "Original custom content must not be sent again");
      assert.ok(!allText(request).includes("FORCED COLLAPSE MODE"));
      assert.ok(!allText(request).includes('"name":"collapse"'), "Successful collapse call must leave model context");
      assert.ok(!allText(request).includes('"toolName":"collapse"'), "Successful collapse result must leave model context");
      assert.equal(request.context.messages.filter(m => JSON.stringify(m).includes("Custom task finished; preserve its result.")).length, remove ? 0 : 1);
      assert.deepEqual(tools(request).sort(), ["collapse", "normal_action"]);
      return [call("normal_1", "normal_action", {})];
    }
    assert.equal(index, 2);
    return [{ type: "text", text: "Normal task complete." }];
  });
  await prompt(f.session, "Continue normal work after collapsing the completed task.");
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests.length, 3, JSON.stringify(f.session.messages.filter(m => m.role === "assistant")));
  assert.equal(f.normalCalls(), 1);
  const op = operations(f.sm)[0];
  assert.ok(op);
  assert.equal((await f.storage.originals(op.id))[0].timestamp, 1, "Archive preserves actual live original");
  assert.ok(f.session.messages.some(message => message.role === "toolResult" && message.toolName === "collapse" && !message.isError));
  assert.ok(f.session.messages.some(message => message.role === "toolResult" && message.toolName === "normal_action" && !message.isError));
  const restored = SessionManager.open(f.sm.getSessionFile()!);
  assert.doesNotThrow(() => project(restored.buildSessionContext().messages, operations(restored)));
  const resumed = await setup(t, { manager: restored, storage: f.storage });
  resumed.script((_index, request) => {
    assert.ok(!allText(request).includes("x".repeat(100)));
    // Successful bookkeeping stays in the audit only; removals leave no placeholder.
    assert.equal(allText(request).includes(op.id), !remove);
    assert.equal(allText(request).includes(`[Collapsed @collapse:${op.id};`), !remove);
    assert.ok(!allText(request).includes('"toolName":"collapse"'));
    return [{ type: "text", text: "Resumed successfully." }];
  });
  await prompt(resumed.session, "Resume");
  assert.deepEqual(resumed.errors, []);
  assert.equal(resumed.requests.length, 1);
});

test("real agent loop: forced inspection retains references until mutation, then both successful pairs disappear", async t => {
  const f = await setup(t, { seed(sm) {
    sm.appendMessage({ role: "user", content: "FINISHED_RANGE " + "x".repeat(20_000), timestamp: 1 });
    for (let i = 0; i < 5; i++) sm.appendMessage({ role: "user", content: "DUPLICATE " + "y".repeat(1000), timestamp: i + 2 });
  } });
  f.script((index, request) => {
    if (index === 0) return [call("lookup", "collapse", { action: "inspect", query: "DUPLICATE", offset: 3, limit: 2 })];
    if (index === 1) {
      assert.deepEqual(tools(request), ["collapse"]);
      const result = request.context.messages.find(m => m.role === "toolResult" && m.toolCallId === "lookup");
      assert.ok(result && result.role === "toolResult");
      const content = result.content[0];
      assert.equal(content.type, "text");
      if (content.type !== "text") throw new Error("Expected inspection text");
      const page = JSON.parse(content.text);
      assert.equal(page.matches[1].message, 6);
      assert.equal(page.protectRecent, 0);
      return [call("mutation", "collapse", { startMatch: "FINISHED_RANGE", endMatch: page.matches[1].reference, summary: "Completed range and five duplicate records archived." })];
    }
    assert.equal(index, 2);
    assert.ok(!allText(request).includes('"name":"collapse"'));
    assert.ok(!allText(request).includes('"toolName":"collapse"'));
    assert.deepEqual(tools(request).sort(), ["collapse", "normal_action"]);
    return [{ type: "text", text: "Normal work resumes." }];
  });
  await prompt(f.session, "Continue normal work.");
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests.length, 3);
  assert.equal(operations(f.sm)[0].originalCount, 6);
  assert.equal(f.session.messages.filter(m => m.role === "toolResult" && m.toolName === "collapse").length, 2, "Both pairs remain in the audit");
  const reopened = SessionManager.open(f.sm.getSessionFile()!);
  assert.ok(!JSON.stringify(project(reopened.buildSessionContext().messages, operations(reopened)).map(r => r.message)).includes('"toolName":"collapse"'));
});

test("real agent loop: mixed successful and failed siblings preserve ordinary work and can later be archived", async t => {
  const explanation = "ORDINARY_EXPLANATION " + "e".repeat(2500);
  const f = await setup(t, { seed(sm) {
    sm.appendMessage({ role: "user", content: "COMPLETED_SOURCE " + "x".repeat(5000), timestamp: 1 });
  } });
  f.script((index, request) => {
    if (index === 0) return [
      { type: "text", text: explanation },
      call("successful", "collapse", { startMatch: "COMPLETED_SOURCE", endMatch: "COMPLETED_SOURCE", summary: "Source work completed." }),
      call("failed", "collapse", { startMatch: "ABSENT", endMatch: "ABSENT", summary: "Unknown." }),
      call("ordinary", "normal_action", {}),
    ];
    if (index === 1) {
      assert.ok(allText(request).includes(explanation));
      assert.ok(!allText(request).includes('"id":"successful"'));
      assert.ok(allText(request).includes('"id":"failed"'));
      assert.ok(allText(request).includes('"id":"ordinary"'));
      assert.ok(allText(request).includes('"toolCallId":"ordinary"'));
      assert.ok(allText(request).includes('"toolCallId":"failed"'));
      return [call("archive_mixed", "collapse", { startMatch: "ORDINARY_EXPLANATION", endMatch: "ORDINARY_EXPLANATION", summary: "Ordinary work completed. The absent-marker collapse failed without changes." })];
    }
    assert.equal(index, 2);
    return [{ type: "text", text: "Finished." }];
  });
  await prompt(f.session, "Continue.");
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests.length, 3);
  assert.equal(f.normalCalls(), 1);
  const ops = operations(f.sm);
  assert.equal(ops.length, 2);
  const originals = await f.storage.originals(ops[1].id);
  const caller = originals.find(m => m.role === "assistant");
  assert.ok(caller?.role === "assistant" && caller.content.some(b => b.type === "toolCall" && b.id === "successful"), "Archive preserves the exact mixed audit original");
  const reopened = SessionManager.open(f.sm.getSessionFile()!);
  assert.doesNotThrow(() => project(reopened.buildSessionContext().messages, operations(reopened)));
});

test("real agent loop: net-expanding collapses are rejected and retries remain bounded", async t => {
  const f = await setup(t, { seed(sm) {
    sm.appendMessage({ role: "user", content: "UNTOUCHED_LARGE_TASK " + "x".repeat(22_000), timestamp: 1 });
    for (let i = 0; i < 5; i++) sm.appendMessage({ role: "user", content: `SMALL_${i} ` + "y".repeat(330), timestamp: i + 2 });
    sm.appendCustomEntry(CONFIG_TYPE, { triggerPercent: 85, targetPercent: 50, protectRecent: 0 });
  } });
  f.script((index, request) => {
    assert.ok(index < 5, "Rejected operations must not count as progress");
    assert.deepEqual(tools(request), ["collapse"]);
    return [call(`small_collapse_${index}`, "collapse", { startMatch: `SMALL_${index}`, endMatch: `SMALL_${index}`, summary: "Done." })];
  });
  await prompt(f.session, "Continue");
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests.length, 5);
  assert.equal(operations(f.sm).length, 0, "No net-expanding replacement may be committed");
  const results = f.session.messages.filter(message => message.role === "toolResult" && message.toolName === "collapse");
  assert.equal(results.length, 5);
  assert.ok(results.every(message => message.role === "toolResult" && message.isError && JSON.stringify(message.content).includes("net savings")));
  assert.ok(allText(f.requests[4]).length > allText(f.requests[0]).length,
    "Rejected calls still have overhead, so the retry bound remains necessary");
});

test("real agent loop: forced exit includes normal prompt guidelines and calibrates the captured request prompt", async t => {
  const capturedPrompts: string[] = [];
  const sent = UsageMeter.prototype.sent;
  t.mock.method(UsageMeter.prototype, "sent", function (this: UsageMeter, ...args: Parameters<UsageMeter["sent"]>) {
    capturedPrompts.push(args[1]);
    return sent.apply(this, args);
  });
  const guideline = "NORMAL_TOOL_GUIDELINE " + "n".repeat(16_000);
  const f = await setup(t, { defaultSystemPrompt: true, normalGuidelines: [guideline], seed(sm) {
    sm.appendMessage({ role: "user", content: "HUGE_HISTORY " + "x".repeat(16_000), timestamp: 1 });
  } });
  f.script((index, request) => {
    assert.deepEqual(tools(request), ["collapse"]);
    assert.match(allText(request), /FORCED COLLAPSE MODE/);
    assert.equal(capturedPrompts[index], request.context.systemPrompt,
      "Calibration must use the prompt captured for this request, not the prompt rebuilt by setActiveTools");
    if (index === 0) {
      assert.ok(request.context.systemPrompt?.includes(guideline), "First forced request still has the normal prompt snapshot");
      return [call("large_collapse", "collapse", { startMatch: "HUGE_HISTORY", endMatch: "HUGE_HISTORY", summary: "Finished." })];
    }
    assert.ok(!request.context.systemPrompt?.includes(guideline), "Subsequent forced requests have the smaller prompt");
    return [{ type: "text", text: "No further useful ranges." }];
  });
  await prompt(f.session, "Continue");
  assert.deepEqual(f.errors, []);
  assert.equal(operations(f.sm).length, 1);
  assert.equal(f.requests.length, 6, "After one successful collapse, five no-progress replies stop the impossible target");
  const states = f.sm.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === FORCE_TYPE ? [entry.data] : []);
  assert.deepEqual(states, [true], "Immutable normal prompt overhead cannot be mistaken for reaching the target");
  assert.equal(f.normalCalls(), 0);
});

test("real agent loop: a reachable target restores normal guidelines and an unsuppressed answer", async t => {
  const guideline = "NORMAL_ACTION_RULE " + "g".repeat(3000);
  const f = await setup(t, { defaultSystemPrompt: true, normalGuidelines: [guideline], seed(sm) {
    sm.appendMessage({ role: "user", content: "LARGE_COMPLETED_WORK " + "x".repeat(22_000), timestamp: 1 });
  } });
  f.script((index, request) => {
    assert.ok(request.context.systemPrompt?.includes(guideline));
    if (index === 0) {
      assert.deepEqual(tools(request), ["collapse"]);
      return [call("guideline_collapse", "collapse", { startMatch: "LARGE_COMPLETED_WORK", endMatch: "LARGE_COMPLETED_WORK", summary: "Completed work." })];
    }
    assert.equal(index, 1);
    assert.deepEqual(tools(request).sort(), ["collapse", "normal_action"]);
    assert.ok(!allText(request).includes("FORCED COLLAPSE MODE"));
    return [{ type: "text", text: "Normal answer after restoring guidelines." }];
  });
  await prompt(f.session, "Continue");
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests.length, 2);
  const states = f.sm.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === FORCE_TYPE ? [entry.data] : []);
  assert.deepEqual(states, [true, false]);
  assert.ok(f.session.messages.some(message => message.role === "assistant" && message.content.some(block =>
    block.type === "text" && block.text === "Normal answer after restoring guidelines.")));
});

test("real agent loop: native truncated-response recovery preserves audit replay after cancelled compaction", async t => {
  const f = await setup(t, { compaction: true, seed(sm) {
    sm.appendMessage({ role: "user", content: "BEGIN_RANGE " + "x".repeat(4000), timestamp: 1 });
  } });
  f.script((index, request) => {
    if (index === 0) return [{ type: "text", text: "Partial response retained in audit" }];
    if (index === 1) {
      assert.match(allText(request), /Partial response retained in audit/,
        "Projection restores Pi's omitted truncated output before new selection");
      return [call("spanning_collapse", "collapse", { startMatch: "BEGIN_RANGE", endMatch: "SECOND_PROMPT", summary: "Earlier work and its partial response are archived." })];
    }
    assert.equal(index, 2);
    return [{ type: "text", text: "Done." }];
  }, index => index === 0 ? { stopReason: "length" } : {});
  await prompt(f.session, "FIRST_PROMPT");
  assert.ok(!f.session.messages.some(message => message.role === "assistant" && message.stopReason === "length"),
    "The real SDK removed the truncated response from live state before the cancelled compaction hook");
  await prompt(f.session, "SECOND_PROMPT");
  assert.deepEqual(f.errors, []);
  assert.equal(operations(f.sm).length, 1);
  assert.ok((await f.storage.originals(operations(f.sm)[0].id)).some(message =>
    message.role === "assistant" && message.stopReason === "length"));
  const reopened = SessionManager.open(f.sm.getSessionFile()!);
  assert.doesNotThrow(() => project(reopened.buildSessionContext().messages, operations(reopened)));
});

test("real agent loop: ignored forced tool choice retries at most five times and suppresses final text", async t => {
  const f = await setup(t, { seed(sm) {
    sm.appendMessage({ role: "user", content: "HUGE " + "x".repeat(22_000), timestamp: 1 });
  } });
  f.script((_index, request) => {
    assert.deepEqual(tools(request), ["collapse"]);
    return [{ type: "text", text: "I refuse to call a tool." }];
  });
  await prompt(f.session, "Continue");
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests.length, 5, JSON.stringify(f.session.messages.filter(m => m.role === "assistant")));
  assert.ok(f.session.messages.filter(message => message.role === "assistant").every(message => message.content.length === 0));
  assert.equal(f.normalCalls(), 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { restrictPayload, SUPPORTED_APIS } from "../src/provider.ts";

const tool = {
  name: "collapse",
  description: "Collapse finished work",
  parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
};
const restrict = (api: string, payload: unknown) => restrictPayload(api, payload, tool) as Record<string, any>;

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

test("completions replaces every tool and legacy function, forces collapse, preserves messages", () => {
  const payload = freezeDeep({ model: "gpt", messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "bash" } }, { type: "web_search" }],
    functions: [{ name: "read" }], function_call: "auto", response_format: { type: "json_object" },
    tool_choice: "auto", parallel_tool_calls: true, temperature: 0.1 });
  const result = restrict("openai-completions", payload);
  assert.deepEqual(result.tools, [{ type: "function", function: { ...tool, strict: false } }]);
  assert.deepEqual(result.tool_choice, { type: "function", function: { name: "collapse" } });
  assert.equal(result.parallel_tool_calls, false);
  assert.equal(result.messages, payload.messages);
  assert.equal(result.temperature, 0.1);
  for (const field of ["functions", "function_call", "response_format"]) assert.equal(field in result, false);
  assert.equal(payload.tools.length, 2);
});

for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"]) {
  test(`${api} removes deferred/builtin tools and supplies collapse from absent snapshot`, () => {
    const message = { role: "user", content: "hello" };
    const oldCall = { type: "function_call", name: "bash", call_id: "old", arguments: "{}" };
    const payload = freezeDeep({ model: "gpt", input: [message, oldCall,
      { type: "additional_tools", tools: [{ name: "read" }] },
      { type: "tool_search_call", call_id: "load" },
      { type: "tool_search_output", call_id: "load", tools: [{ name: "write" }] }],
      tools: [{ type: "web_search" }, { type: "mcp", server_label: "remote" }],
      text: { verbosity: "low", format: { type: "json_schema" } },
      reasoning: { effort: "high" } });
    const result = restrict(api, payload);
    assert.deepEqual(result.tools, [{ type: "function", ...tool, strict: false }]);
    assert.deepEqual(result.tool_choice, { type: "function", name: "collapse" });
    assert.deepEqual(result.input, [message, oldCall]);
    assert.deepEqual(result.text, { verbosity: "low" });
    assert.deepEqual(result.reasoning, { effort: "high" });
    assert.equal(result.parallel_tool_calls, false);
    assert.equal(restrict(api, { model: "gpt", input: [] }).tools[0].name, "collapse");
    assert.throws(() => restrict(api, { model: "gpt", input: [], previous_response_id: "r" }), /server-managed/);
    assert.throws(() => restrict(api, { model: "gpt", input: [], conversation: "c" }), /server-managed/);
  });
}

test("Anthropic disables thinking and strips deferred references, retaining tool pairs", () => {
  const payload = freezeDeep({ model: "claude", thinking: { type: "adaptive" },
    output_config: { effort: "high" }, mcp_servers: [{ name: "remote" }],
    context_management: { edits: [{ type: "clear_tool_uses" }] },
    messages: [
      { role: "assistant", content: [
        { type: "thinking", thinking: "secret", signature: "s" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "tool_use", id: "old", name: "bash", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: [
        { type: "tool_reference", tool_name: "read" },
      ] }] },
      { role: "user", content: "Continue" },
    ], tools: [{ type: "tool_search_tool_regex_20251119", name: "tool_search" }] });
  const result = restrict("anthropic-messages", payload);
  assert.deepEqual(result.thinking, { type: "disabled" });
  assert.equal("output_config" in result, false);
  assert.equal("mcp_servers" in result, false);
  assert.equal("context_management" in result, false);
  assert.deepEqual(result.tools, [{ name: "collapse", description: tool.description, input_schema: tool.parameters }]);
  assert.deepEqual(result.tool_choice, { type: "tool", name: "collapse", disable_parallel_tool_use: true });
  assert.deepEqual(result.messages[0].content, [{ type: "tool_use", id: "old", name: "bash", input: {} }]);
  assert.equal(result.messages[1].content[0].tool_use_id, "old");
  assert.deepEqual(result.messages[1].content[0].content, [{ type: "text", text: "[No retained content]" }]);
  assert.equal(result.messages[2].content, "Continue");
});

test("Anthropic without thinking does not add model-specific thinking options", () => {
  const result = restrict("anthropic-messages", { model: "claude", messages: [] });
  assert.equal("thinking" in result, false);
});

for (const api of ["google-generative-ai", "google-vertex"]) {
  test(`${api} uses SDK config nesting, removes builtins and constrains allowed names`, () => {
    const abortSignal = new AbortController().signal;
    const payload = { model: "gemini", contents: [], config: {
      abortSignal, maxOutputTokens: 4000, thinkingConfig: { thinkingLevel: "LOW" },
      tools: [{ googleSearch: {} }, { codeExecution: {} }, { functionDeclarations: [{ name: "bash" }] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      responseMimeType: "application/json", responseSchema: { type: "object" },
    } };
    const result = restrict(api, payload);
    assert.deepEqual(result.config.tools, [{ functionDeclarations: [{
      name: "collapse", description: tool.description, parametersJsonSchema: tool.parameters,
    }] }]);
    assert.deepEqual(result.config.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["collapse"] } });
    assert.equal(result.config.abortSignal, abortSignal);
    assert.equal(result.config.maxOutputTokens, 4000);
    assert.equal("responseMimeType" in result.config, false);
    assert.equal("responseSchema" in result.config, false);
    assert.equal(payload.config.tools.length, 3);
    assert.throws(() => restrict(api, { model: "gemini", contents: [], config: { cachedContent: "cached" } }), /cached/);
  });
}

test("rejects unsupported APIs, malformed payloads and wrong tool definitions", () => {
  assert.throws(() => restrict("unknown", {}), /does not support/);
  assert.throws(() => restrict("bedrock-converse-stream", {}), /does not support/);
  for (const payload of [null, [], "text", {}, { model: "" }]) {
    assert.throws(() => restrict("openai-completions", payload), /invalid|no model/);
  }
  assert.throws(() => restrict("openai-completions", { model: "gpt", messages: "bad" }), /array/);
  assert.throws(() => restrict("openai-responses", { model: "gpt", input: [null] }), /input item/);
  assert.throws(() => restrict("anthropic-messages", { model: "claude", messages: [{ content: null }] }), /content/);
  assert.throws(() => restrict("google-vertex", { model: "g", contents: [], config: [] }), /config/);
  assert.throws(() => restrictPayload("openai-completions", {}, { ...tool, name: "bash" }), /definition/);
  assert.throws(() => restrictPayload("openai-completions", {}, { ...tool, parameters: [] }), /parameters/);
  assert.equal(SUPPORTED_APIS.length, 7);
});

test("never mutates a deeply frozen tool schema", () => {
  const frozen = freezeDeep(structuredClone(tool));
  assert.doesNotThrow(() => restrictPayload("openai-completions", { model: "gpt", messages: [] }, frozen));
});

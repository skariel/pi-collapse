import test from "node:test";
import assert from "node:assert/strict";
import { identify, type Message } from "../src/core.ts";
import { UsageMeter } from "../src/usage.ts";

function response(input: number, cacheRead = 0, stopReason: "stop" | "toolUse" | "error" = "stop"): Message {
  return { role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "test", timestamp: 1, stopReason,
    usage: { input, cacheRead, cacheWrite: 0, output: 0, totalTokens: input + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("calibration uses actual forced tools but exit estimates retain the full normal tool budget", () => {
  const meter = new UsageMeter();
  const rows = identify([{ role: "user", content: "small retained history", timestamp: 1 }]);
  const forcedTools = [{ name: "collapse", description: "compact", parameters: {} }];
  const normalTools = [...forcedTools, { name: "huge_tool", description: "x".repeat(40_000), parameters: {} }];
  const before = meter.estimate(rows, "system", normalTools);
  const actual = meter.estimate(rows, "system", forcedTools);
  meter.sent(rows, "system", forcedTools);
  meter.received(response(actual, 0, "toolUse"));
  const after = meter.estimate(rows, "system", normalTools);
  assert.ok(after >= before);
  assert.ok(after > actual + 9000, "normal schemas were not silently calibrated away");
});

test("provider input and cache counts calibrate prompt estimation; error/aborted outputs do not", () => {
  const meter = new UsageMeter();
  const rows = identify([{ role: "user", content: "hello", timestamp: 1 }]);
  const estimate = meter.estimate(rows, "", []);
  meter.sent(rows, "", []);
  meter.received(response(999999, 0, "error"));
  assert.equal(meter.estimate(rows, "", []), estimate);
  meter.received(response(estimate, estimate));
  assert.equal(meter.estimate(rows, "", []), estimate, "failed request calibration cannot leak into a later response");
  meter.sent(rows, "", []);
  meter.received(response(estimate, estimate));
  assert.equal(meter.estimate(rows, "", []), estimate * 2);
});

test("forced Anthropic calibration excludes removed thinking and cannot discount normal requests", () => {
  const meter = new UsageMeter();
  const normal = { api: "anthropic-messages", provider: "anthropic", model: "claude" };
  const forced = { ...normal, forced: true };
  const textRows = identify([{ role: "user", content: "x".repeat(4000), timestamp: 1 }]);
  const thought = response(0);
  assert.equal(thought.role, "assistant");
  if (thought.role !== "assistant") throw new Error("expected assistant");
  thought.content = [{ type: "thinking", thinking: "t".repeat(80000), thinkingSignature: "sig" },
    { type: "text", text: "Done" }];
  const rows = [...textRows, ...identify([thought])];
  const tools = [{ name: "collapse" }];
  const retained = [...textRows, ...identify([{ ...thought, content: [{ type: "text" as const, text: "Done" }] }])];
  const sentEstimate = meter.estimate(retained, "", tools, forced);
  assert.equal(meter.estimate(rows, "", tools, forced), sentEstimate);
  assert.ok(meter.estimate(rows, "", tools, normal) > sentEstimate + 19000);
  const normalBefore = meter.estimate(textRows, "", tools, normal);
  const forcedBefore = meter.estimate(textRows, "", tools, forced);
  meter.sent(rows, "", tools, forced);
  meter.received(response(sentEstimate, 0, "toolUse"));
  assert.equal(meter.estimate(textRows, "", tools, forced), forcedBefore, "removed thinking cannot poison later retained-text estimate");
  assert.equal(meter.estimate(textRows, "", tools, normal), normalBefore);
  assert.equal(thought.content[0].type, "thinking", "estimation leaves audit history untouched");
});

test("calibration is isolated by provider, model, API and normal/forced mode", () => {
  const meter = new UsageMeter();
  const rows = identify([{ role: "user", content: "hello", timestamp: 1 }]);
  const profile = { api: "openai-responses", provider: "openai", model: "test", forced: false };
  const before = meter.estimate(rows, "", [], profile);
  meter.sent(rows, "", [], profile);
  meter.received(response(before * 2));
  assert.equal(meter.estimate(rows, "", [], profile), before * 2);
  for (const other of [{ ...profile, provider: "proxy" }, { ...profile, model: "other" },
    { ...profile, api: "openai-completions" }, { ...profile, forced: true }]) {
    assert.equal(meter.estimate(rows, "", [], other), before);
  }
});

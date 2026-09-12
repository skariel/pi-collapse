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
  assert.equal(meter.estimate(rows, "", []), estimate * 2);
});

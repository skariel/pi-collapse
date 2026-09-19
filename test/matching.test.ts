import test from "node:test";
import assert from "node:assert/strict";
import { boundary, identify, matchMessage, selectRange, surfaces, type Message } from "../src/core.ts";

const user = (content: string, timestamp = 1): Message => ({ role: "user", content, timestamp });
const result = (content: string, details?: unknown): Message => ({ role: "toolResult", toolName: "fork", toolCallId: "fork-id",
  content: [{ type: "text", text: content }], details, isError: false, timestamp: 2 });

test("literal matching ignores hidden fork transcripts and opaque metadata", () => {
  const hidden = '"offset":1332';
  const rows = identify([
    result("Visible fork findings", { activities: [{ argsPreview: hidden }], messages: [user("secret-metadata-only")] }),
    user(`Read request: ${hidden}`),
  ]);
  assert.equal(matchMessage(rows, hidden, "startMatch"), 1);
  assert.equal(matchMessage(rows, "Visible fork findings", "startMatch"), 0);
  assert.ok(!surfaces(rows[0].message).some(text => text.includes("secret-metadata-only")));
  assert.throws(() => matchMessage(rows, "secret-metadata-only", "startMatch"), /not found/);
});

test("invented or cross-session references fail explicitly, never become literal selectors", () => {
  const rows = identify([user("@message:unlikely @message:not-present")]);
  for (const ref of ["@message:unlikely", "@message:not-present"]) {
    assert.throws(() => matchMessage(rows, ref, "startMatch"), /invalid message reference/);
  }
  const elsewhere = boundary(identify([user("elsewhere")])[0]);
  assert.throws(() => matchMessage(rows, elsewhere, "startMatch"), /reference not found.*another session/);
});

test("both ambiguous boundaries return exact references in one rejection; echoes do not break reference retry", () => {
  const rows = identify([user("START literal", 1), user("END literal", 2),
    user('Previous failed arguments: {"startMatch":"START literal","endMatch":"END literal"}', 3)]);
  assert.throws(() => selectRange(rows, "START literal", "END literal", 0), error => {
    const text = String(error);
    assert.match(text, /startMatch: ambiguous/);
    assert.match(text, /endMatch: ambiguous/);
    assert.ok(text.includes(boundary(rows[0])));
    assert.ok(text.includes(boundary(rows[1])));
    return true;
  });
  assert.deepEqual(selectRange(rows, boundary(rows[0]), boundary(rows[1]), 0), [0, 1]);
});

test("a partially resolved range supplies the other boundary's reference for a safe retry", () => {
  const rows = identify([user("unique start"), user("end", 2), user("end", 3)]);
  assert.throws(() => selectRange(rows, "unique start", "end", 0), error => {
    assert.ok(String(error).includes(`startMatch resolved: ${boundary(rows[0])}`));
    assert.match(String(error), /endMatch: ambiguous/);
    return true;
  });
});

test("ambiguous candidates show the match location, not identical long prefixes", () => {
  const rows = identify([user("prefix ".repeat(200) + "first MATCH_MARKER ending", 1),
    user("prefix ".repeat(200) + "second MATCH_MARKER ending", 2)]);
  assert.throws(() => matchMessage(rows, "MATCH_MARKER", "startMatch"), error => {
    const text = String(error);
    assert.match(text, /first MATCH_MARKER/);
    assert.match(text, /second MATCH_MARKER/);
    assert.ok(text.length < 1500);
    return true;
  });
});

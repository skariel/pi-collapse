import test from "node:test";
import assert from "node:assert/strict";
import { boundary, identify, lookupMessages, matchMessage, selectRange, surfaces, type Message } from "../src/core.ts";

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

test("paged discovery reaches every identical-visible occurrence with usable references", () => {
  const rows = identify(Array.from({ length: 5 }, (_, i) => user("same content", i)));
  const first = lookupMessages(rows, "same content", 0, 3);
  assert.equal(first.total, 5);
  assert.equal(first.nextOffset, 3);
  const second = lookupMessages(rows, "same content", first.nextOffset!, 3);
  assert.deepEqual(second.matches.map(match => match.message), [4, 5]);
  assert.equal(second.nextOffset, null);
  for (const item of [...first.matches, ...second.matches]) {
    assert.equal(matchMessage(rows, item.reference, "startMatch"), item.message - 1);
    assert.equal(item.eligible, true);
    assert.deepEqual(selectRange(rows, item.range!.startMatch, item.range!.endMatch, 0), [item.message - 1, item.message - 1]);
  }
  assert.equal(lookupMessages(rows, second.matches[1].reference).matches[0].message, 5);
  assert.equal(lookupMessages(rows, "SAME CONTENT").total, 0, "Lookup uses the same exact visible matching as selection");
});

test("discovery exposes group-expanded protection and bounds preview/output", () => {
  const rows = identify([user("start " + "x".repeat(100_000)), result("orphan", { secret: "hidden needle" }), user("latest", 3)]);
  const page = lookupMessages(rows, "", 0, 20, 1);
  assert.deepEqual(page.matches.map(item => item.eligible), [true, false, false]);
  assert.match(page.matches[1].reason!, /incomplete/);
  assert.match(page.matches[2].reason!, /protected latest 1/);
  assert.ok(page.matches.every(item => item.preview.length <= 241));
  assert.equal(lookupMessages(rows, "hidden needle").total, 0);
  assert.deepEqual(lookupMessages(rows, "", 100).matches, []);
  assert.equal(lookupMessages(rows, "", 100).nextOffset, null);
  for (const [offset, limit] of [[-1, 10], [0.5, 10], [0, 0], [0, 21]]) {
    assert.throws(() => lookupMessages(rows, "", offset, limit), /Require/);
  }
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

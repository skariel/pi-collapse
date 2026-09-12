# pi-collapse

Agent-directed range compaction for **`@earendil-works/pi-coding-agent`** (developed/tested against 0.85.1).

## Install

```sh
npm install
pi install /absolute/path/to/collapse
# Restart pi, or /reload
```

For a single run: `pi -e ./src/index.ts`.

**Important API limitation:** pi does not expose arbitrary persistent transcript replacement to extensions. This package persists collapse operations in the session and replaces the history **sent to the model**, including after restart, fork, and tree navigation. `/collapse view` shows that effective history. The built-in transcript/tree/export remains the original **audit log**; old rows are not visually removed. Pi's ordinary context indicator may also show unprojected history; `/collapse status` provides the extension's projected usage estimate. True in-place TUI replacement requires a pi core API change. No private session mutation or session-file rewriting is used.

## Tool

```json
{
  "startMatch": "unique literal text from the first message",
  "endMatch": "unique literal text from the last message",
  "summary": "Task completed. Important decisions, constraints, results, paths, and remaining work…"
}
```

To archive and **remove** a range entirely from model context, pass exactly `"summary": ""`. No summary or placeholder replaces it. Use this only when the range contains no unique still-relevant constraints, decisions, results, rationale, or unfinished work—for example, redundant logs or obsolete documentation dumps. Whitespace-only summaries are rejected. All normal matching, protection, tool-group, and archive-before-commit rules still apply. The original UI transcript and the collapse call/result remain; this is not secure erasure.

Removed ranges remain discoverable in `/collapse list`, `/collapse show <id>`, and `/collapse originals <id>`, including after restart. Removing an existing summary flattens its originals into the new archive. A previously removed range has no selectable placeholder, so later collapses spanning its former position do not absorb that archive; it remains independently listed on the branch. Sessions containing removals require this version or newer; older versions reject empty-summary journal entries.

The `collapse` description asks the agent to review opportunities after completed tasks, not to make a call mechanically after each task. Outside forced mode, tiny or actively needed ranges should be left alone when overhead or lost detail outweighs the benefit. The agent first identifies current constraints, unresolved tasks, acceptance criteria, and dependencies, then ranks safe candidates by completion certainty, lower dependency risk, older age, and larger expected savings. Repetitive resolved logs and replaceable documentation are preferred to fragments of active work.

Summaries should emphasize decisions and rationale, verified results/evidence paths, and remaining work—not a play-by-play or a fixed sentence count. Guidance also asks the agent to remove explicitly superseded directives, label historical states and plans, and distinguish implemented work from verified results and proposals. Later decisions used to reconcile an older range must be identified as later updates. These are model instructions, not a runtime guarantee of summary quality; mechanical protection and forced-mode enforcement remain unchanged.

- Both boundaries are **inclusive**, and both matches must identify exactly one message. Repeated occurrences within that message are allowed.
- Boundaries can also be exact returned references: `@collapse:<uuid>` for a current summary, or `@message:<key>` for an ordinary message. References resolve identity, not copies appearing in tool results or arguments. The tool returns a summary reference after each nonempty collapse; `/collapse list`, `/collapse view`, and match-error suggestions also provide references. Superseded or removed references do not retarget other messages.
- Otherwise matching is literal, case-sensitive, and whitespace-sensitive. Searches cover compact `JSON.stringify(message)` and every decoded string value inside it. Thus raw multiline text and JSON fragments both work. No fuzzy selection. Missing/ambiguous matches suggest bounded nearby candidates; these are never selected automatically.
- Any message role can be collapsed, including users, tool messages, and earlier summaries. System instructions/tool schemas are not history messages and cannot be collapsed.
- Tool-call/result groups expand **outward**, including sibling calls/results and intervening messages. Missing/ambiguous tool pairs are rejected, never split.
- The latest **10** model-visible messages are normally protected. The snapshot excludes the assistant response currently calling collapse, preventing self-matches against its arguments.
- New range summaries must be smaller than the selected range, including the archive marker. Outside forced mode, a correction selecting **exactly one existing summary** may keep the same estimated size or grow by up to 20%, capped at 128 tokens. This allowance is for correcting facts or stale instructions, not repeated expansion. Forced mode always requires shrinking. An empty summary contributes zero replacement tokens.
- Protection errors report the expanded range and suggest up to three eligible complete ranges, with usable references. Candidates are ranked by serialized content size, not semantic suitability: the agent must still check whether each range is safe to summarize/remove. Incomplete groups and protected ranges are never suggested.
- Multiple independent ranges can be submitted in one response. Commits serialize; choose ranges that remain disjoint after tool-group expansion, without dependencies on newly created summaries/IDs. A later overlapping call may need to retry against the updated history. Batching useful cleanup can reduce repeated cache disruption, but does not guarantee cache preservation.

To correct an existing summary without UUID matches colliding with old tool results:

```json
{
  "startMatch": "@collapse:<current-summary-uuid>",
  "endMatch": "@collapse:<current-summary-uuid>",
  "summary": "Corrected current decisions and remaining work…"
}
```

Use the actual reference returned by the tool. Protection still applies. The correction creates a new archive/reference; originals remain flattened and retrievable.

## Archives and nesting

Originals are saved before the session journal is updated:

```text
~/.pi/collapse/messages-<uuid>.jsonl
```

Each line is an original pi message object; **the filename's UUID is the collapse ID**. Summaries include that ID. Use ordinary `read`, `bash`, `grep`, or `find` to retrieve originals outside forced mode. Archives can include user text, secrets, tool output, images, and other sensitive content. New directories are mode `0700`, files `0600`; contents are not encrypted.

Collapsing any mixture of regular messages and summaries produces one **flat chronological archive**. The replacement summary supersedes the old summaries; old IDs leave the active list. Superseded archives are retained because historical tree positions and independent forked session files can still reference them. There is deliberately no automatic garbage collection: pi has no global reference index for all possible session locations.

Archives use a synced temporary file and atomic, exclusive publication before appending one session journal entry (an existing ID cannot be overwritten). Config updates use atomic rename. Cancellation/write errors do not intentionally commit a replacement. A crash between archive creation and journal append can leave an unreferenced archive, which is safe. Session-journal durability follows pi's own persistence guarantees. In-memory/`--no-session` sessions do not survive restart, although their archives remain.

## Forced mode

Defaults: enter at **85%**, continue until **≤50%**.

The extension checks projected context before each request, restricts provider tool declarations and named tool choice to `collapse`, independently blocks every other tool execution, and discards finalized ordinary assistant text during forcing. If the model nevertheless answers without calling collapse, it is prompted again. Five consecutive responses without a net reduction of more than 32 estimated history tokens (including actual call/result overhead) abort the run instead of looping indefinitely. A hard limit of 64 forced requests per run also bounds repeated small improvements. Retry with a new prompt after inspecting status/configuration. Escape still cancels.

Recent-message protection is waived when no old complete group is eligible or when the protected tail alone prevents reaching the target. Tool-pair integrity is **never** waived. The current in-flight response is never eligible; a very large current request or immutable system/tool overhead can make the target impossible. There is no fallback summarizer.

Usage is an **estimate**, using pi's message estimator plus system/tool overhead, calibrated from provider-reported input/cache usage after responses. A new process starts with the estimator until its first response. This is not an exact tokenizer or a promise that a request fits every provider's limits. A single oversized user/tool message can overflow before a model can summarize it. The normal tool budget is included when deciding to exit forced mode.

Forced payload adapters support:

- OpenAI Completions, Responses, Codex Responses, Azure Responses
- Anthropic Messages (extended thinking disabled while forcing)
- Google Generative AI and Vertex

Unsupported APIs (including Bedrock), server-managed Responses history, and Google cached-content requests abort forced generation rather than silently weakening the restriction. Individual proxy/model compatibility needs live verification. Streaming text can briefly appear in pi's UI before finalized text is removed; extensions have no pre-render streaming veto.

Pi's native automatic/manual compaction is **cancelled by hooks**, including overflow compaction. `/tree` summarization is blocked; navigate without a summary. Existing native summaries in an imported session remain ordinary collapsible messages; this package cannot recover their already-discarded content. Global pi settings are not rewritten. Do not enable competing memory/context-transforming extensions: replay detects changed history and aborts rather than dropping unidentified messages. Later-loaded extensions can override shared hooks; this is not a security boundary against other installed code.

## Commands

The status bar shows `collapse 42 messages | 3 archives`: original messages represented by currently active summaries or removed ranges, and their archive count. Recollapsing counts flattened originals once; superseded archives retained on disk do not count. Forced mode displays `COLLAPSE ONLY` instead of `collapse`. Context usage is not repeated in the status bar.

| Command | Effect |
| --- | --- |
| `/collapse status` | Settings, forced state, projected usage, estimated history savings, summarized/removed message counts, active archive bytes and unavailable archive IDs |
| `/collapse list` | Active collapse IDs, summaries or removal labels, archive paths on this branch |
| `/collapse view` | Effective replacement history (built-in transcript remains an audit log) |
| `/collapse show <id>` | Operation metadata/summary on this branch, including superseded IDs |
| `/collapse originals <id>` | Original JSONL preview and path (also works for retained IDs) |
| `/collapse config` | Effective and global settings |
| `/collapse config session {"protectRecent":5}` | Persist a per-session/branch override |
| `/collapse config global {"triggerPercent":90,"targetPercent":55}` | Save global defaults |
| `/collapse config reset` | Clear the session override and follow global defaults |

`/collapse status` compares estimated history tokens before/after applying the journal. It includes summary markers but excludes system/tool schemas. Both sides retain collapse call/result messages, so the reported saving is **not** a counterfactual net saving versus never using the tool, nor a billing/cache-savings figure. Archive bytes count only active archives on this branch (including removals); superseded files and other sessions are excluded. Unavailable files are listed separately, and their bytes are not included. This is not a content-integrity check. The status bar remains a compact message/archive count.

Global configuration: `~/.pi/collapse/config.json`.

```json
{"triggerPercent":85,"targetPercent":50,"protectRecent":10}
```

Require `0 < targetPercent < triggerPercent < 100`; `protectRecent` is a nonnegative integer. Session overrides are complete snapshots and follow branches. Global changes do not overwrite them. Other running pi processes load updated globals on reload/session navigation. Commands wait for idle; TUI previews use an editor whose edits are discarded. RPC uses notifications. Previews are capped at 50,000 characters; use filesystem tools for full archives. Commands require TUI/RPC for visible output.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests cover exact/ambiguous matching, JSON/raw strings, group expansion, protection, nested flattening, archive permissions/failures, concurrent operations, real SessionManager persistence/reopen/branches, forced-mode lifecycle, configuration, native-compaction cancellation, and provider payload adapters. Actual SDK agent-loop tests cover summary and removal execution, immediate normal-tool restoration, custom-message persistence/reopen, text suppression, and net-expanding collapses. Removal tests also cover archive discovery, branching, summary flattening, protection, concurrent requests, and archive failures. Only provider transport is mocked; tests do not make paid/live provider calls.

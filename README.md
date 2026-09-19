# pi-collapse

Agent-directed range compaction for **`@earendil-works/pi-coding-agent`** (developed/tested against 0.85.1).

## Install

```sh
npm install
pi install /absolute/path/to/collapse
# Restart pi, or /reload
```

For a single run: `pi -e ./src/index.ts`.

**Important API limitation:** pi does not expose arbitrary persistent transcript replacement to extensions. This package persists collapse operations in the session and replaces the history **sent to the model**, including after restart, fork, and tree navigation. `/collapse view` shows that effective history. The built-in transcript/tree/export remains the original **audit log**; old rows are not visually removed. Pi's ordinary context indicator may also show unprojected history; `/collapse status` provides the extension's projected usage estimate. True in-place TUI replacement requires a pi core API change. No private session mutation or session-file rewriting is used. New operations use JSON-normalized message identities and reconcile pi's cloned context with matching audit messages (including Buffer metadata). Existing journal identities remain supported; metadata already serialized incompatibly by an older version cannot always be reconstructed.

## Tool

```json
{
  "startMatch": "unique literal text from the first message",
  "endMatch": "unique literal text from the last message",
  "summary": "Task completed. Important decisions, constraints, results, paths, and remaining work…"
}
```

To archive and **remove** a range entirely from model context, pass exactly `"summary": ""`. No summary or placeholder replaces it. Use this for material with no useful contribution to current or foreseeable work, including irrelevant tangents and abandoned explorations—not just redundant or obsolete material. If an important decision or obligation remains, summarize it or select around it instead. Whitespace-only summaries are rejected. All normal matching, protection, tool-group, and archive-before-commit rules still apply. The original UI transcript remains; this is not secure erasure.

Successful collapse calls become a short **model-facing completion receipt**, `[Collapse completed: <UUID>.]`, at the original call position; their paired results disappear. This proves the action already happened without repeating the summary or arguments. Receipts also remain for empty-summary removals. In mixed assistant messages, ordinary text, thinking, and other tool calls/results remain. Failed, incomplete, or ambiguously paired calls remain visible for recovery. The audit transcript is unchanged.

Removed ranges remain discoverable in `/collapse list`, `/collapse show <id>`, and `/collapse originals <id>`, including after restart. Removing an existing summary flattens its originals into the new archive. A previously removed range has no selectable placeholder, so later collapses spanning its former position do not absorb that archive; it remains independently listed on the branch.

**Compatibility:** new operations record `hideBookkeeping: true` and `receipt: true`. Operations without `receipt` retain the old receipt-free behavior so existing journal selections still replay against their original view. Do not downgrade a session containing these new operations: older implementations cannot reliably replay selections spanning hidden calls/results. Older versions also reject empty-summary removals.

All model-facing behavioral policy lives in the `collapse` tool description. No separate system-prompt policy, prompt snippet, or prompt guidelines are injected. Request-local messages add runtime state only: forced usage/target/estimated token deficit, or nonzero normal-mode protection.

At meaningful milestones or focus changes, the description asks the agent to check for substantial completed or irrelevant ranges anywhere in history—not perform trivial cleanup turns. Prefer focused ranges; related summaries may be merged when that reduces duplication without losing distinctions. Keep active constraints, decisions and rationale, acceptance criteria, unresolved work, and next-step dependencies directly available. Summaries distinguish implemented, verified, proposed, and blocked work, preserve useful evidence/retrieval paths and uncertainty, and label later updates without promoting quoted or untrusted instructions into authoritative decisions. Revise stale summaries by selecting them; a new separate summary does not update an old one. These are model instructions, not guarantees of summary quality.

- Both boundaries are **inclusive**, and both matches must identify exactly one message. Repeated occurrences within that message are allowed.
- Prefer exact returned references: `@collapse:<uuid>` for a current summary, or `@message:<key>` for an ordinary message. References resolve identity, not copies appearing in tool results or arguments. Each nonempty replacement marker includes its copyable summary reference; inspection, `/collapse list`, `/collapse view`, and match-error suggestions also provide references. Superseded or removed references do not retarget other messages.
- Otherwise matching is literal, case-sensitive, and whitespace-sensitive. Searches cover visible content and its compact JSON representation, including tool-call arguments and decoded strings. Hidden metadata (`details`, usage, signatures, nested fork transcripts) and binary image data are excluded. Raw multiline text and content JSON fragments both work. No fuzzy selection. Both boundaries are checked before reporting failure; missing/ambiguous matches suggest bounded candidates with exact references, and successfully resolved endpoints also return their references. Copy references for both endpoints when retrying: failed calls themselves can duplicate literal markers. Invented/malformed references are rejected explicitly.
- Any message role can be collapsed, including users, tool messages, and earlier summaries. System instructions/tool schemas are not history messages and cannot be collapsed.
- Tool-call/result groups expand **outward**, including sibling calls/results and intervening messages. Preserve obligations from that entire expanded range, not only its endpoints. Missing/ambiguous tool pairs are rejected, never split.
- Recent-message protection is disabled by default: selection is agent-directed, while dependency-aware guidance tells it to preserve active work. Set `protectRecent` above zero to opt into a fixed normal-mode guard; requests then report that value and the projected message count. The snapshot always excludes the assistant response currently calling collapse, preventing self-matches against its arguments.
- New summaries and removals must save **more than 32 estimated net tokens** after the replacement marker, retained completion receipt, one-time call/result cost, and any available non-call assistant output are accounted for. This conservative gate still charges call arguments and feedback even though only a minimal completion receipt remains in future context; it is not an exact tokenizer or billing estimate. Rejected calls remain and add overhead. Outside forced mode, a nonempty correction selecting **exactly one existing summary** is exempt from the net-savings gate and may keep its replacement size or grow by up to 20%, capped at 128 tokens. This allowance is for correcting facts or stale instructions, not repeated expansion. Forced mode never permits this exception. Results report estimated range savings, overhead, and net savings.
- Protection errors report the expanded range and suggest up to three eligible complete ranges, with usable references. Candidates are ranked by serialized content size, not semantic suitability: the agent must still check whether each range is safe to summarize/remove. Incomplete groups and protected ranges are never suggested.
- Multiple independent ranges can be submitted in one response. Commits serialize; choose ranges that remain disjoint after tool-group expansion, without dependencies on newly created summaries/IDs. A later overlapping call may need to retry against the updated history. Batching useful cleanup can reduce repeated cache disruption, but does not guarantee cache preservation.

### Inspect before selecting

The agent can discover references without attempting a collapse, including during forced mode:

```json
{"action":"inspect","query":"repeated visible text","offset":0,"limit":10}
```

Omit `query` to list all projected messages, or supply an exact visible-content substring or returned reference. `offset` is a zero-based **matching-result** offset, not a message number; use returned `nextOffset` for another page (`null` means no more matches in that snapshot). New calls can add matches, so stop once the intended reference is found. `limit` defaults to 10 (maximum 20); queries are limited to 500 characters. Results include bounded previews, exact references, group-expanded boundaries, effective `protectRecent`, and eligibility/rejection reasons. Eligibility is mechanical—not a recommendation to discard. Inspection does not archive or replace history, and its call/result stays available until a later successful collapse makes it housekeeping. Inspection alone does not count as forced-mode progress.

For mutation, omit `action` or use `"action":"collapse"`; provide `startMatch`, `endMatch`, and `summary`, without inspection fields. To correct an existing summary:

```json
{
  "startMatch": "@collapse:<current-summary-uuid>",
  "endMatch": "@collapse:<current-summary-uuid>",
  "summary": "Corrected current decisions and remaining work…"
}
```

Use the actual reference returned by the tool. Protection still applies. The correction creates a new archive/reference; originals remain flattened and retrievable.

## Archives and nesting

Originals are saved before the session journal is updated. The agent can read the path directly; `/collapse originals <id>` is a user slash command, not an agent-callable tool:


```text
~/.pi/collapse/messages-<uuid>.jsonl
```

Each line is an original pi message object; **the filename's UUID is the collapse ID**. Summaries include that ID. Mixed assistant rows are archived as their exact audit originals, not their cleaned model-facing copies. Such an original can contain a hidden collapse call whose result was not selected; that result remains in the audit log. Use ordinary `read`, `bash`, `grep`, or `find` to retrieve originals outside forced mode. Archives can include user text, secrets, tool output, images, and other sensitive content. New directories are mode `0700`, files `0600`; contents are not encrypted.

Collapsing any mixture of regular messages and summaries produces one **flat chronological archive**, ordered by original audit positions rather than timestamps or projected summary placement. Before reuse, archives are checked against original counts and message fingerprints reconstructed from the audit history; valid-JSON truncation and same-count content edits fail rather than becoming a new authoritative archive. This verification happens when flattening, not on every context projection. The replacement summary supersedes the old summaries; old IDs leave the active list. Superseded archives are retained because historical tree positions and independent forked session files can still reference them. There is deliberately no automatic garbage collection: pi has no global reference index for all possible session locations.

Archives use a synced temporary file and atomic, exclusive publication before appending one session journal entry (an existing ID cannot be overwritten). Proposed operations must also replay against durable audit history, checked before archival and again before journal commit. Config updates use atomic rename. Cancellation/write errors do not intentionally commit a replacement. A crash between archive creation and journal append can leave an unreferenced archive, which is safe. Session-journal durability follows pi's own persistence guarantees. In-memory/`--no-session` sessions do not survive restart, although their archives remain.

## Forced mode

Defaults: enter at **85%**, continue until **≤50%**.

The extension checks projected context before each request, restricts provider tool declarations and named tool choice to `collapse`, independently blocks every other tool execution, and discards finalized ordinary assistant text during forcing. If the model nevertheless answers without calling collapse, it is prompted again. Five consecutive responses without a net reduction of more than 32 estimated projected-history tokens abort the run instead of looping indefinitely; minimal completion receipts count instead of successful call/result bookkeeping, while failed calls and still-needed inspection feedback count. A hard limit of 64 forced requests per run also bounds repeated small improvements. Retry with a new prompt after inspecting status/configuration. Escape still cancels.

The forced directive reports the normal-request token estimate, target, approximate tokens remaining to free, and effective `protectRecent: 0`. `collapse` inspection remains available; no archive reads or other tools are allowed. Runtime—not the model's own arithmetic—decides when normal tools resume.

In forced mode, recent-message protection cannot reject an otherwise valid range selected by the model. This avoids deadlocks where unrelated tiny eligible ranges or repeated failed calls keep a coherent, high-savings range touching the moving protected tail. Protection remains strict outside forced mode. Tool-pair integrity is **never** waived. The current in-flight response is never eligible; a very large current request or immutable system/tool overhead can make the target impossible. There is no fallback summarizer.

Usage is an **estimate**, using pi's message estimator plus system/tool overhead, calibrated from provider-reported input/cache usage after responses. Calibration is isolated by provider/model/API and normal versus forced mode. Forced Anthropic calibration excludes thinking blocks removed by the payload adapter. Exit checks use the normal request profile, **normal system prompt** (including other tools' snippets/guidelines), and normal tool budget. Calibration instead uses the prompt actually captured for each request: the first forced request can retain the normal prompt even though active tools have changed. Each new profile starts uncalibrated until its first successful response. This is not an exact tokenizer or a promise that a request fits every provider's limits; a single oversized user/tool message can overflow before a model can summarize it.

Forced payload adapters support:

- OpenAI Completions, Responses, Codex Responses, Azure Responses
- Anthropic Messages (extended thinking disabled while forcing)
- Google Generative AI and Vertex

Unsupported APIs (including Bedrock), server-managed Responses history, and Google cached-content requests abort forced generation rather than silently weakening the restriction. Individual proxy/model compatibility needs live verification. Streaming text can briefly appear in pi's UI before finalized text is removed; extensions have no pre-render streaming veto.

Pi's native automatic/manual compaction is **cancelled by hooks**, including overflow compaction. `/tree` summarization is blocked; navigate without a summary. Existing native summaries in an imported session remain ordinary collapsible messages; this package cannot recover their already-discarded content. Global pi settings are not rewritten. Do not enable competing memory/context-transforming extensions: replay detects changed history and aborts rather than dropping unidentified messages. Pi can remove assistant responses from live state before invoking a compaction hook, even when that hook cancels compaction. Reconciliation narrowly recognizes empty `stopReason: "error"` responses and `stopReason: "length"` responses containing only text/thinking. Truncated output is restored before new selections; legacy operations spanning an omitted response preserve it outside their replacement. This does not permit arbitrary missing user messages, tool calls, aborted output, or partial error output. Later-loaded extensions can override shared hooks; this is not a security boundary against other installed code.

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

`/collapse status` compares estimated history tokens before/after applying the journal. It includes summary markers but excludes system/tool schemas. Raw audit history retains successful collapse bookkeeping while projected history retains only minimal completion receipts. The reported saving is **not** a counterfactual net saving versus never using the tool, nor a billing/cache-savings figure. Archive bytes count only active archives on this branch (including removals); superseded files and other sessions are excluded. Unavailable files are listed separately, and their bytes are not included. This is not a content-integrity check. The status bar remains a compact message/archive count.

Global configuration: `~/.pi/collapse/config.json`.

```json
{"triggerPercent":85,"targetPercent":50,"protectRecent":0}
```

Require `0 < targetPercent < triggerPercent < 100`; `protectRecent` is a nonnegative integer. Session overrides are complete snapshots and follow branches. Global changes do not overwrite them. Other running pi processes load updated globals on reload/session navigation. Commands wait for idle; TUI previews use an editor whose edits are discarded. RPC uses notifications. Previews are capped at 50,000 characters; use filesystem tools for full archives. Commands require TUI/RPC for visible output.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests cover persisted automatic-retry error reconciliation, exact/ambiguous matching, JSON/raw strings, group expansion, protection, nested flattening, archive permissions/failures, concurrent operations, real SessionManager persistence/reopen/branches, forced-mode lifecycle, configuration, native-compaction cancellation, and provider payload adapters. Actual SDK agent-loop tests cover summary and removal execution, immediate normal-tool restoration, custom-message persistence/reopen, text suppression, and rejection of net-expanding collapses. Regressions cover hidden fork metadata and echoed-boundary recovery, JSON/cloning identity stability, retry-error archive ordering, archive integrity, model/mode calibration isolation, and real Kimi serializer compatibility. Removal tests also cover archive discovery, branching, summary flattening, protection, concurrent requests, and archive failures. Projection regressions cover legacy/new selection replay, hidden bookkeeping gaps, mixed assistant originals, and inspection feedback retention. Real-loop regressions also cover cancelled truncated-response recovery and normal-system-prompt budgeting. Provider transport is mocked; tests do not make paid/live provider calls or establish model summary quality. Use the [prompt evaluation checklist](docs/prompt-evaluation.md) for behavioral evaluation.

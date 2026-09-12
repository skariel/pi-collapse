import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { buildSessionContext, estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  apply, boundary, CONFIG_TYPE, DEFAULT_CONFIG, FORCE_TYPE, nextForced, OP_TYPE,
  identify, project, selectRange, summaryRow, validateCollapse, validateConfig,
  type Collapse, type Config, type Message, type Row,
} from "./core.ts";
import { Storage } from "./storage.ts";
import { restrictPayload } from "./provider.ts";
import { rowTokens, UsageMeter } from "./usage.ts";

const parameters = Type.Object({
  startMatch: Type.String({ minLength: 1, description: "Exact substring or returned @collapse:/@message: reference identifying the inclusive first message" }),
  endMatch: Type.String({ minLength: 1, description: "Exact substring or returned @collapse:/@message: reference identifying the inclusive last message" }),
  summary: Type.String({ description: "Short replacement preserving decisions, constraints, results, and unfinished work; exactly empty string archives and removes the range without a replacement" }),
}, { additionalProperties: false });

export function description(directory: string): string {
  return `Actively manage memory: review collapse opportunities after every finished task or substantial completed subtask; act proactively when useful, rather than waiting for context pressure. Outside forced mode, skip tiny or still-actively-needed ranges when call/result overhead or lost detail outweighs the benefit. Replace an inclusive range of any messages (including user messages and earlier collapse summaries) with a short, accurate summary. Preserve user constraints, decisions, useful results, paths, and unfinished work. This replaces pi compaction; there is no other automatic summarizer.
Before selecting ranges, identify current user constraints, unresolved tasks, unmet acceptance criteria, and facts that ongoing work depends on. Prefer leaving actively needed detail intact; never discard those dependencies merely because they are old. If a range contains them, preserve them explicitly in its summary. Rank safe candidates by completion certainty first (explicit completion or verification evidence), then lower dependency risk, then older age, then larger expected savings. Prefer repetitive resolved-error logs, completed iterations, and replaceable documentation dumps over small fragments of active work. Partition around still-needed detail where possible, while keeping complete tool groups together. Size-based tool suggestions are only candidates, not a relevance assessment. Do this assessment internally, then execute useful collapses without a separate planning-only response.
Use summary: "" (exactly empty, not whitespace) to archive and completely remove a range from model context without a summary or placeholder. Use this only for redundant or obsolete material with no unique still-relevant constraints, decisions, results, rationale, or unfinished work. If anything useful remains, summarize it instead. Originals are still archived and discoverable via /collapse list; the original UI transcript remains. Tool-group integrity and recent-message protection still apply. The collapse call/result itself remains ordinary history.
Prefer outcomes over chronology: preserve decisions and their rationale, verified results and evidence paths, and remaining work rather than narrating every intermediate step. Use enough detail for safe continuation; there is no fixed sentence limit. Treat summarization as memory maintenance, not just shortening text. When newer explicit decisions supersede older instructions or plans, remove the obsolete directives from the replacement or clearly label them historical; do not present an old “next step” as current. When later work changed a state, write “At that point, X was unimplemented; later work changed this” rather than leaving “X is unimplemented” as an apparent current fact. Preserve still-applicable user constraints, unresolved work, and useful rationale. If supersession is uncertain, retain the uncertainty rather than silently discarding an instruction. Distinguish implemented, verified, proposed, and blocked work. When using later context to resolve an older range, identify the update as a later decision rather than implying it occurred in the archived range. To clean up an earlier summary, select that summary in a collapse range; a new summary elsewhere does not edit it.
History rewrites can invalidate cached prefixes. When already collapsing, consider cleaning up other eligible stale summaries and large completed logs/documentation in the same response, rather than repeatedly rewriting history across turns. You may issue multiple independent collapse calls in one response (parallel submission is supported; commits serialize for safety). Choose ranges that remain disjoint after tool-group expansion, and use existing message text as boundaries. Do not make one call depend on a summary or ID created by another call in the same response. Batch useful cleanup, not gratuitous rewrites; each replacement must reduce size except for the bounded single-summary correction allowance below.
Exactly three arguments: startMatch, endMatch, summary. Each boundary accepts either a literal substring (case-sensitive, whitespace-sensitive, not fuzzy) or an exact returned reference: @collapse:<uuid> targets a current summary, @message:<key> targets a current ordinary message. References resolve message identity, ignoring copies in tool arguments/results. Use the same reference for startMatch and endMatch to edit one summary. Superseded/deleted references no longer resolve; use current suggestions or /collapse list/view. Literal matching otherwise behaves as follows. Search covers compact JSON.stringify(message) and each decoded string value anywhere inside the message, including text, content, tool arguments/results, and JSON. Each match must identify exactly one message; repetitions within that message are okay. Missing or ambiguous matches return bounded closest candidates for you to retry EXACTLY. Boundaries are inclusive. Tool requests and all sibling results must stay together: boundaries expand outward, preferring MORE messages. Incomplete/in-flight tool groups can never be collapsed.
Normally the latest 10 messages are protected (configurable). At 85% context usage, only collapse is permitted until usage reaches at most 50% (both configurable; see the current system instructions). In forced mode, recent-message protection is waived for an otherwise valid selected range so protection cannot deadlock recovery; tool integrity is never waived. Ordinary answers and other tools are not allowed during forced mode. New range summaries must reduce estimated context size. Outside forced mode, correcting exactly one existing summary may retain its size or grow by at most 20% of its previous estimated size, capped at 128 tokens; use this only for factual/current-state corrections, not gratuitous rewrites. Forced mode always requires shrinking.
Each replacement has a UUID. Originals are saved as one original message per JSONL line at ${directory}/messages-[id].jsonl BEFORE history changes. The filename contains the collapse ID. Outside forced mode use read, bash, grep, or find to retrieve originals there; no special retrieval tool is needed. Collapsing existing summaries flattens their originals together with regular messages in chronological order into ONE new archive. Old summaries and IDs disappear from active history; old archives remain for historical branches/forks. The new summary is authoritative; do not rely on old summaries. Only the history visible before your current response can be selected; your current tool request is not a matching candidate. Outputs and match suggestions are bounded.`;
}

export default function collapseExtension(pi: ExtensionAPI) {
  registerCollapse(pi, new Storage(join(homedir(), ".pi", "collapse")));
}

/** Separate storage injection keeps tests isolated from the user's global archives. */
export function registerCollapse(pi: ExtensionAPI, storage: Storage) {
  const toolDescription = description(storage.directory);
  const toolDefinition = { name: "collapse", description: toolDescription, parameters };
  let globalConfig: Config = { ...DEFAULT_CONFIG };
  let config: Config = { ...DEFAULT_CONFIG };
  let operations: Collapse[] = [];
  let rows: Row[] | undefined;
  let forced = false;
  let requestForced = false;
  let previousTools: string[] | undefined;
  let meter = new UsageMeter();
  let percent = 0;
  let failures = 0;
  let requestStartSize = 0;
  let forcedTurns = 0;
  let epoch = 0;
  let queue = Promise.resolve();
  let fault: string | undefined;

  function restoreTools() {
    if (previousTools) { pi.setActiveTools(previousTools); previousTools = undefined; }
  }
  function activeDefinitions() {
    const active = previousTools ?? pi.getActiveTools();
    return pi.getAllTools().filter(t => active.includes(t.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
  function tokens(ctx: ExtensionContext, value = rows ?? []) {
    // Use the normal tool budget even while forcing, so restoring tools does not immediately retrigger.
    return meter.estimate(value, ctx.getSystemPrompt(), activeDefinitions());
  }
  function activeOperations(visible: Row[]) {
    const visibleIds = new Set(visible.flatMap(row => row.collapseId ? [row.collapseId] : []));
    // Removals have no visible row; their archives remain independently active on this branch.
    return operations.filter(op => op.summary === "" || visibleIds.has(op.id));
  }
  function updateStatus(ctx: ExtensionContext, visible = rows ?? []) {
    const active = activeOperations(visible);
    const activeIds = new Set(active.map(op => op.id));
    const messages = active.reduce((sum, op) => sum + op.originalCount, 0);
    ctx.ui.setStatus("collapse", `${forced ? "COLLAPSE ONLY" : "collapse"} ${messages} ${messages === 1 ? "message" : "messages"} | ${activeIds.size} ${activeIds.size === 1 ? "archive" : "archives"}`);
  }
  function policy() {
    return `Collapse memory policy: trigger ${config.triggerPercent}%, target <=${config.targetPercent}%, protect latest ${config.protectRecent} messages normally. Originals: ${storage.directory}/messages-[id].jsonl (UUID in filename; use read/bash outside forced mode). Proactively review completed work for useful collapse, preserving active dependencies and avoiding tiny low-value rewrites outside forced mode. A request-local collapse directive indicates forced mode: then call only collapse, never other tools or ordinary answers. Without that directive, resume normal work; historical retry notices do not indicate current forced state.`;
  }
  function guide() {
    return `${policy()}\nFORCED COLLAPSE MODE (${percent.toFixed(1)}% estimated usage): call only collapse until <=${config.targetPercent}%. No normal answers or other tools. Summarize completed tasks first.`;
  }
  function stop(ctx: ExtensionContext, error: unknown) {
    fault = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Collapse stopped: ${fault}`, "error");
    ctx.abort();
  }
  function replay(ctx: ExtensionContext) {
    operations = [];
    config = { ...globalConfig };
    forced = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === OP_TYPE) operations.push(validateCollapse(entry.data));
      if (entry.customType === CONFIG_TYPE) config = entry.data === null ? { ...globalConfig } : validateConfig(entry.data);
      if (entry.customType === FORCE_TYPE) {
        if (typeof entry.data !== "boolean") throw new Error("Invalid collapse force-state journal entry");
        forced = entry.data;
      }
    }
  }
  async function reset(ctx: ExtensionContext) {
    epoch++;
    restoreTools();
    rows = undefined;
    meter = new UsageMeter();
    failures = 0;
    forcedTurns = 0;
    requestForced = false;
    fault = undefined;
    try { globalConfig = await storage.config(); replay(ctx); updateStatus(ctx, viewRows(ctx)); }
    catch (error) { stop(ctx, error); }
  }
  function viewRows(ctx: ExtensionContext): Row[] {
    return project(buildSessionContext(ctx.sessionManager.getBranch()).messages, operations);
  }
  function protection(): number {
    // Forced requests are already restricted to collapse, and the in-flight
    // assistant call is absent from rows. Do not let unrelated small eligible
    // ranges deadlock a coherent selected range behind the recent tail.
    // Tool-group integrity remains strict inside selectRange.
    return requestForced ? 0 : config.protectRecent;
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", () => { epoch++; restoreTools(); rows = undefined; });
  pi.on("agent_end", () => { restoreTools(); });
  pi.on("session_before_compact", () => ({ cancel: true }));
  pi.on("session_before_tree", (event, ctx) => {
    if (event.preparation.userWantsSummary) {
      ctx.ui.notify("Collapse replaces branch summarization. Navigate again without summarizing.", "warning");
      return { cancel: true };
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    failures = 0;
    forcedTurns = 0;
    // Ensure a fresh run snapshots normal tools; the payload gate restricts them if needed.
    restoreTools();
    if (fault) { stop(ctx, fault); return; }
    return { systemPrompt: `${event.systemPrompt}\n\n${policy()}` };
  });
  pi.on("context", (event, ctx) => {
    try {
      if (fault) throw new Error(fault);
      replay(ctx);
      rows = project(event.messages, operations);
      const window = ctx.model?.contextWindow;
      if (!window || window <= 0) throw new Error("Model has no valid context window; cannot enforce collapse thresholds");
      percent = tokens(ctx) / window * 100;
      const next = nextForced(forced, percent, config);
      if (next !== forced) { pi.appendEntry(FORCE_TYPE, next); forced = next; }
      requestForced = forced;
      if (forced) {
        if (failures >= 5 || ++forcedTurns > 64) {
          ctx.ui.notify("Forced collapse retry limit reached. Retry with a new prompt or adjust /collapse config.", "error");
          ctx.abort();
          return { messages: [] };
        }
        previousTools ??= pi.getActiveTools();
        pi.setActiveTools(["collapse"]);
      } else { restoreTools(); forcedTurns = 0; }
      requestStartSize = rowTokens(rows);
      updateStatus(ctx);
      const sentRows = [...rows];
      if (forced) sentRows.push({ key: "directive", message: { role: "custom", customType: "collapse.directive", content: guide(), display: false, timestamp: Date.now() } });
      const messages = sentRows.map(r => r.message);
      // Calibration must describe the actual payload, not the larger hypothetical normal request.
      meter.sent(sentRows, ctx.getSystemPrompt(), forced ? [toolDefinition] : activeDefinitions());
      return { messages };
    } catch (error) {
      stop(ctx, error);
      // Extension exceptions are swallowed by pi. Abort AND return empty context, never raw originals.
      return { messages: [] };
    }
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!requestForced && !fault) return;
    try {
      if (fault) throw new Error(fault);
      return restrictPayload(ctx.model?.api ?? "", event.payload, toolDefinition);
    } catch (error) { stop(ctx, error); return {}; }
  });
  pi.on("tool_call", (event) => {
    if (fault || (requestForced && event.toolName !== "collapse")) {
      return { block: true, reason: fault ?? "Forced collapse mode: only collapse is allowed", terminate: Boolean(fault) };
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    meter.received(event.message);
    if (requestForced) {
      // Keep calls so pi can produce correctly paired blocked results for disallowed tools.
      return { message: { ...event.message, content: event.message.content.filter(b => b.type === "toolCall") } };
    }
  });
  pi.on("turn_end", (event, ctx) => {
    if (!requestForced || fault || ctx.signal?.aborted) return;
    try {
      const after = viewRows(ctx); // Includes this assistant's actual call and all results.
      const madeProgress = rowTokens(after) < requestStartSize - 32;
      failures = madeProgress ? 0 : failures + 1;
      percent = tokens(ctx, after) / (ctx.model?.contextWindow ?? 1) * 100;
      if (percent <= config.targetPercent) {
        forced = false;
        pi.appendEntry(FORCE_TYPE, false);
        // Release BEFORE pi snapshots the next turn's executable tools.
        restoreTools();
        updateStatus(ctx, after);
        return;
      }
    } catch (error) { stop(ctx, error); return; }
    if (failures >= 5) {
      // A retry on a later user prompt remains possible; don't permanently poison session state.
      ctx.ui.notify("Collapse paused after five responses without progress. Check /collapse status and retry.", "error");
      ctx.abort();
      return;
    }
    if (event.message.role === "assistant" && event.message.stopReason !== "error" && event.message.stopReason !== "aborted" &&
        !event.message.content.some(b => b.type === "toolCall")) {
      pi.sendMessage({ customType: "collapse.retry", content: "Continue according to the current request-local collapse directive. If no directive is present, resume the user's task.", display: false }, { deliverAs: "steer" });
    }
  });

  pi.registerTool({
    ...toolDefinition, label: "Collapse", promptSnippet: "Summarize finished tasks or archive and remove redundant history",
    promptGuidelines: ["Use collapse proactively after every finished task; in forced collapse mode call only collapse until the configured target is reached."],
    async execute(_id, params, signal, _update, ctx) {
      const generation = epoch;
      const task = queue.then(async () => {
        if (signal?.aborted || generation !== epoch) throw new Error("Collapse cancelled or session changed");
        if (fault) throw new Error(fault);
        if (!rows) throw new Error("No model-visible history snapshot yet");
        if (params.summary !== "" && !params.summary.trim()) throw new Error('Use exactly summary: "" to remove a range; whitespace-only summaries are invalid');
        const protectedCount = protection();
        const [start, end] = selectRange(rows, params.startMatch, params.endMatch, protectedCount);
        const selected = rows.slice(start, end + 1);
        const originals = await storage.flatten(selected);
        const op: Collapse = { version: 1, id: randomUUID(), keys: selected.map(r => r.key), summary: params.summary,
          timestamp: Date.now(), originalCount: originals.length, supersedes: selected.flatMap(r => r.collapseId ? [r.collapseId] : []) };
        const beforeTokens = rowTokens(selected);
        const afterTokens = op.summary === "" ? 0 : estimateTokens(summaryRow(op).message) + 4;
        const correction = !requestForced && selected.length === 1 && !!selected[0].collapseId;
        const growthLimit = Math.min(128, Math.floor(beforeTokens * 0.2));
        if (afterTokens >= beforeTokens && !(correction && afterTokens <= beforeTokens + growthLimit)) {
          throw new Error(correction
            ? `Summary correction exceeds its growth allowance (${growthLimit} estimated tokens). Shorten it or select a larger range.`
            : "Summary (including archive marker) must be shorter than the selected messages. Select a larger range or shorten the summary.");
        }
        await storage.archive(op.id, originals);
        if (signal?.aborted || generation !== epoch) throw new Error("Collapse cancelled; unreferenced archive retained safely");
        // One durable journal entry commits the replacement. No mutation before the archive exists.
        pi.appendEntry(OP_TYPE, op);
        rows = apply(rows, op);
        operations.push(op);
        updateStatus(ctx);
        const estimated = tokens(ctx) / (ctx.model?.contextWindow ?? 1) * 100;
        return { content: [{ type: "text" as const, text: `${op.summary === "" ? "Archived and removed" : "Collapsed"} messages ${start + 1}–${end + 1} ${op.summary === "" ? "without a replacement; archive ID" : "into"} ${op.id} (${originals.length} originals). Archive: ${storage.path(op.id)}.${op.summary === "" ? "" : ` To revise this summary, use startMatch and endMatch: ${boundary(summaryRow(op))}.`} Estimated context: ${estimated.toFixed(1)}%.${protectedCount < config.protectRecent ? " Recent-message protection waived to reach the forced target." : ""}${requestForced ? ` Continue calling collapse until <=${config.targetPercent}%; normal tools resume on the next request after reaching it.` : ""}` }], details: { id: op.id, originalCount: originals.length, removed: op.summary === "", boundary: op.summary === "" ? null : boundary(summaryRow(op)), estimatedRangeTokensSaved: beforeTokens - afterTokens } };
      });
      queue = task.then(() => {}, () => {});
      return task;
    },
  });

  pi.registerCommand("collapse", {
    description: "Manage collapse: status, list, view, show <id>, originals <id>, config [session|global <JSON>|reset]",
    async handler(args, ctx) {
      await ctx.waitForIdle();
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        replay(ctx);
        if (command === "config") {
          const [scope, ...json] = rest;
          if (scope === "reset") { pi.appendEntry(CONFIG_TYPE, null); config = { ...globalConfig }; }
          else if (scope) {
            if (scope !== "session" && scope !== "global") throw new Error("Use config session <JSON>, config global <JSON>, or config reset");
            const patch: unknown = JSON.parse(json.join(" "));
            if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Expected a JSON object");
            const next = validateConfig({ ...(scope === "global" ? globalConfig : config), ...patch });
            if (scope === "global") { await storage.saveConfig(next); globalConfig = next; replay(ctx); }
            else { pi.appendEntry(CONFIG_TYPE, next); config = next; }
          }
          fault = undefined;
          ctx.ui.notify(JSON.stringify({ effective: config, global: globalConfig }), "info");
          return;
        }
        const visible = viewRows(ctx);
        let text: string;
        if (command === "status") {
          const window = ctx.model?.contextWindow;
          const active = activeOperations(visible);
          const raw = identify(buildSessionContext(ctx.sessionManager.getBranch()).messages);
          const rawTokens = rowTokens(raw), projectedTokens = rowTokens(visible);
          const archives = await storage.archiveSizes(active.map(op => op.id));
          text = JSON.stringify({ config, forced, estimatedPercent: window ? tokens(ctx, visible) / window * 100 : null,
            activeCollapses: activeOperations(visible).length, removedRanges: activeOperations(visible).filter(op => op.summary === "").length, archiveDirectory: storage.directory, fault: fault ?? null,
            summarizedMessages: active.filter(op => op.summary !== "").reduce((sum, op) => sum + op.originalCount, 0),
            removedMessages: active.filter(op => op.summary === "").reduce((sum, op) => sum + op.originalCount, 0),
            estimatedHistoryTokens: { withoutCollapse: rawTokens, withCollapse: projectedTokens, saved: rawTokens - projectedTokens,
              savedPercent: rawTokens ? Math.round((rawTokens - projectedTokens) / rawTokens * 1000) / 10 : 0 },
            activeArchiveBytes: archives.bytes, unavailableArchives: archives.unavailable,
            note: "History savings compare retained audit messages with projected history, including summary markers; system/tool schemas are excluded. Both include collapse call/result overhead, so this is not net savings versus a session that never used collapse. Archive bytes cover readable active archives only, not superseded files or other sessions. Native transcript remains an audit log." }, null, 2);
        } else if (command === "list") {
          text = activeOperations(visible).map(op => `${op.id}  ${storage.path(op.id)}\n${op.originalCount} originals — ${op.summary === "" ? "[removed without replacement]" : `${boundary(summaryRow(op))}\n${op.summary.slice(0, 300)}`}`).join("\n\n") || "No active collapses on this branch.";
        } else if (command === "view") {
          text = visible.map((r, i) => `# Message ${i + 1} ${boundary(r)}${r.collapseId ? ` (collapse ${r.collapseId})` : ""}\n${JSON.stringify(r.message, null, 2)}`).join("\n\n");
        } else if (command === "show" || command === "originals") {
          if (rest.length !== 1) throw new Error(`Use /collapse ${command} <id>`);
          const id = rest[0];
          const path = storage.path(id);
          const op = operations.find(o => o.id === id);
          text = command === "originals" ? `${path}\n\n${(await storage.originals(id)).map(m => JSON.stringify(m)).join("\n")}` :
            op ? JSON.stringify({ ...op, path, active: activeOperations(visible).some(o => o.id === id), removed: op.summary === "" }, null, 2) : `ID is not on this branch. Archive: ${path}`;
        } else throw new Error("Use /collapse status|list|view|show <id>|originals <id>|config");
        const bounded = text.length > 50_000 ? text.slice(0, 50_000) + "\n[Preview truncated; use read/bash on the archive for full originals.]" : text;
        if (ctx.mode === "tui" && command !== "status") await ctx.ui.editor(`Collapse: ${command} (view only; edits are discarded)`, bounded);
        else ctx.ui.notify(bounded, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}

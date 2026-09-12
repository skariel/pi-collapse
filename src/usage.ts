import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Message, Row } from "./core.ts";

export const rowTokens = (rows: Row[]) => rows.reduce((sum, r) => sum + 4 + estimateTokens(r.message), 0);

/** Calibrated estimate of the projected request, never pi's unprojected history size. */
export class UsageMeter {
  private scale = 1;
  private requestEstimate: number | undefined;
  estimate(rows: Row[], systemPrompt: string, tools: unknown): number {
    return Math.ceil(this.scale * this.rawEstimate(rows, systemPrompt, tools));
  }
  private rawEstimate(rows: Row[], systemPrompt: string, tools: unknown): number {
    return rowTokens(rows) + Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 4) + 256;
  }
  sent(rows: Row[], systemPrompt: string, tools: unknown): void {
    this.requestEstimate = this.rawEstimate(rows, systemPrompt, tools);
  }
  received(message: Message): void {
    if (message.role !== "assistant" || !this.requestEstimate || message.stopReason === "error" || message.stopReason === "aborted") return;
    const u = message.usage;
    const actual = u.input + u.cacheRead + u.cacheWrite;
    if (actual > 0 && Number.isFinite(actual)) this.scale = actual / this.requestEstimate;
    this.requestEstimate = undefined;
  }
}

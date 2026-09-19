import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Message, Row } from "./core.ts";
import { estimationRows, type RequestProfile } from "./provider.ts";

export const rowTokens = (rows: Row[]) => rows.reduce((sum, r) => sum + 4 + estimateTokens(r.message), 0);

/** Calibrated projected request estimate, isolated by model and serialization mode. */
export class UsageMeter {
  private scales = new Map<string, number>();
  private request: { estimate: number; key: string } | undefined;
  private key(profile: RequestProfile): string {
    return JSON.stringify([profile.provider ?? "", profile.model ?? "", profile.api ?? "", !!profile.forced]);
  }
  estimate(rows: Row[], systemPrompt: string, tools: unknown, profile: RequestProfile = {}): number {
    return Math.ceil((this.scales.get(this.key(profile)) ?? 1) * this.rawEstimate(rows, systemPrompt, tools, profile));
  }
  private rawEstimate(rows: Row[], systemPrompt: string, tools: unknown, profile: RequestProfile): number {
    return rowTokens(estimationRows(rows, profile)) + Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 4) + 256;
  }
  sent(rows: Row[], systemPrompt: string, tools: unknown, profile: RequestProfile = {}): void {
    this.request = { estimate: this.rawEstimate(rows, systemPrompt, tools, profile), key: this.key(profile) };
  }
  received(message: Message): void {
    if (message.role !== "assistant") return;
    const request = this.request;
    this.request = undefined;
    if (!request || message.stopReason === "error" || message.stopReason === "aborted") return;
    const u = message.usage;
    const actual = u.input + u.cacheRead + u.cacheWrite;
    if (actual > 0 && Number.isFinite(actual)) this.scales.set(request.key, actual / request.estimate);
  }
}

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, isArchiveId, messageFingerprint, validateConfig, type Config, type Message, type Row } from "./core.ts";

/** Archives are immutable. Superseded IDs remain for historical branches and forked sessions. */
export class Storage {
  constructor(readonly directory: string) {}
  path(id: string): string {
    if (!isArchiveId(id)) throw new Error("Invalid archive ID");
    return join(this.directory, `messages-${id}.jsonl`);
  }
  private async atomic(path: string, content: string, exclusive = false): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
      if (exclusive) await link(temp, path); // Atomic publication, never overwrite an existing archive.
      else await rename(temp, path);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(() => {}); }
  }
  async archive(id: string, messages: Message[]): Promise<void> {
    // IDs are freshly generated UUIDs, never caller-controlled.
    await this.atomic(this.path(id), messages.map(m => JSON.stringify(m)).join("\n") + "\n", true);
  }
  async archiveSizes(ids: string[]): Promise<{ bytes: number; unavailable: string[] }> {
    let bytes = 0;
    const unavailable: string[] = [];
    for (const id of new Set(ids)) {
      try { bytes += (await stat(this.path(id))).size; }
      catch { unavailable.push(id); }
    }
    return { bytes, unavailable };
  }
  async originals(id: string): Promise<Message[]> {
    const text = await readFile(this.path(id), "utf8");
    const messages: Message[] = text.trimEnd().split("\n").map(line => JSON.parse(line));
    if (!messages.length || messages.some(m => !m || typeof m !== "object" || typeof m.role !== "string")) {
      throw new Error(`Invalid archive ${id}`);
    }
    return messages;
  }
  async flatten(rows: Row[]): Promise<Message[]> {
    const result: { message: Message; position?: number }[] = [];
    for (const row of rows) {
      const messages = row.collapseId ? await this.originals(row.collapseId) : [row.message];
      const invalid = () => new Error(`Archive integrity check failed for ${row.collapseId ?? row.key}; no replacement was committed`);
      if (row.collapseId && row.originalCount !== undefined && messages.length !== row.originalCount) throw invalid();
      if (!row.originals) {
        // Standalone legacy callers can verify counts; projection supplies full provenance.
        result.push(...messages.map(message => ({ message })));
        continue;
      }
      if (messages.length !== row.originals.length) throw invalid();
      const positions = new Map<string, number[]>();
      for (const original of row.originals) positions.set(original.hash, [...(positions.get(original.hash) ?? []), original.position]);
      for (const list of positions.values()) list.sort((a, b) => a - b);
      for (const message of messages) {
        const position = positions.get(messageFingerprint(message))?.shift();
        if (position === undefined) throw invalid();
        result.push({ message, position });
      }
    }
    // Retry audit errors may sit after a projected summary although they occurred
    // between its originals. Audit positions recover order even for tied timestamps
    // and for archives written in the old, incorrectly concatenated order.
    if (result.every(item => item.position !== undefined)) result.sort((a, b) => a.position! - b.position!);
    return result.map(item => item.message);
  }
  async config(): Promise<Config> {
    try {
      const data: unknown = JSON.parse(await readFile(join(this.directory, "config.json"), "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Collapse config must be a JSON object");
      return validateConfig({ ...DEFAULT_CONFIG, ...data });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
      throw error;
    }
  }
  async saveConfig(config: Config): Promise<void> {
    await this.atomic(join(this.directory, "config.json"), JSON.stringify(validateConfig(config), null, 2) + "\n");
  }
}

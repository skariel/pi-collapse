import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, validateConfig, type Config, type Message, type Row } from "./core.ts";

/** Archives are immutable. Superseded IDs remain for historical branches and forked sessions. */
export class Storage {
  constructor(readonly directory: string) {}
  path(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid archive ID");
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
    const result: Message[] = [];
    for (const row of rows) {
      for (const message of row.collapseId ? await this.originals(row.collapseId) : [row.message]) result.push(message);
    }
    return result;
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

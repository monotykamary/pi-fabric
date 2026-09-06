import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../core/atomic-write.js";
import type { FabricMeshConfig } from "../config.js";
import type { MeshEvent, MeshStore } from "../mesh/store.js";

const MESH_WATCH_RECONCILE_MS = 2_000;

/** Owns observation resources and the format-1 cursor, never actor ownership or dispatch policy. */
export class ActorMeshMonitor {
  #timer: NodeJS.Timeout | undefined;
  #watcher: FSWatcher | undefined;
  #offset: number;
  #scheduled = false;
  #polling = false;
  #closed = false;
  #started = false;

  constructor(
    readonly mesh: Pick<MeshStore, "root" | "latestOffset" | "tail">,
    readonly config: Pick<FabricMeshConfig, "enabled" | "actorPollMs" | "maxReadEvents">,
    readonly callbacks: {
      cursorPath?: string | undefined;
      beforePoll(): boolean;
      onEvent(event: MeshEvent): void;
    },
  ) {
    this.#offset = this.#readCursor() ?? mesh.latestOffset();
  }

  start(): void {
    if (this.#started || this.#closed || !this.config.enabled) return;
    this.#started = true;
    if (process.platform === "win32") {
      this.#startTimer(this.config.actorPollMs);
      this.schedule();
      return;
    }
    try {
      const watcher = fs.watch(this.mesh.root, { persistent: false }, (_event, filename) => {
        if (filename !== null && path.basename(filename.toString()) !== "events.jsonl") return;
        this.schedule();
      });
      this.#watcher = watcher;
      watcher.on("error", () => this.#fallback(watcher));
      this.#startTimer(Math.max(MESH_WATCH_RECONCILE_MS, this.config.actorPollMs));
    } catch {
      this.#startTimer(this.config.actorPollMs);
    }
    this.schedule();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  schedule(): void {
    if (this.#scheduled || this.#closed || !this.config.enabled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      void this.#poll().catch(() => undefined);
    });
  }

  #fallback(watcher: FSWatcher): void {
    if (this.#closed || this.#watcher !== watcher) return;
    watcher.close();
    this.#watcher = undefined;
    this.#startTimer(this.config.actorPollMs);
    this.schedule();
  }

  #startTimer(delay: number): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = setInterval(() => this.schedule(), delay);
    this.#timer.unref();
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#closed || !this.config.enabled) return;
    if (!this.callbacks.beforePoll()) return;
    this.#polling = true;
    try {
      const tail = this.mesh.tail(this.#offset, this.config.maxReadEvents);
      this.#offset = tail.nextOffset;
      for (const event of tail.events) this.callbacks.onEvent(event);
      this.#writeCursor();
    } finally {
      this.#polling = false;
    }
  }

  #readCursor(): number | undefined {
    if (!this.callbacks.cursorPath) return undefined;
    try {
      const value = JSON.parse(fs.readFileSync(this.callbacks.cursorPath, "utf8")) as {
        format?: unknown;
        cursor?: unknown;
      };
      return value.format === 1 && typeof value.cursor === "number" && value.cursor >= 0
        ? value.cursor
        : undefined;
    } catch {
      return undefined;
    }
  }

  #writeCursor(): void {
    if (!this.callbacks.cursorPath) return;
    try {
      writeJsonAtomic(this.callbacks.cursorPath, { format: 1, cursor: this.#offset }, { space: 2 });
    } catch {
      // Cursor persistence is best-effort; replay resumes from the latest safe cursor.
    }
  }
}

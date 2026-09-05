import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";

const remove = (directory: string): void => {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Cleanup failure must never prevent restoring the live reader state.
  }
};
const abandoned = new FinalizationRegistry<string>(remove);
const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** Private lossless disk storage; no serialized payload stays resident. */
export class NativeReaderCheckpoint<T> {
  readonly #directory: string;
  readonly #digest: string;

  constructor(value: T) {
    const data = serialize(value);
    this.#digest = digest(data);
    this.#directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-reader-"));
    try {
      fs.chmodSync(this.#directory, 0o700);
      const temporary = path.join(this.#directory, "pending");
      fs.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, path.join(this.#directory, "checkpoint"));
    } catch (error) {
      remove(this.#directory);
      throw error;
    }
    abandoned.register(this, this.#directory, this);
  }

  restore(): T {
    const file = path.join(this.#directory, "checkpoint");
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const data = fs.readFileSync(descriptor);
      if (digest(data) !== this.#digest) throw new Error("reader checkpoint checksum mismatch");
      return deserialize(data) as T;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  dispose(): void {
    remove(this.#directory);
    abandoned.unregister(this);
  }
}

type EventRecord = Record<string, unknown>;

/** Lossless final-state replay of a loaded, contiguous RPC range. */
export class NativeReaderEventReplay {
  readonly #records = new Map<number, EventRecord>();
  readonly #partials = new Map<string, number>();
  #queue: number | undefined;
  #next = 0;

  constructor(records: Iterable<EventRecord> = []) {
    for (const record of records) this.append(record);
  }

  append(record: EventRecord): void {
    const index = this.#next++;
    if (record.type === "queue_update") {
      if (this.#queue !== undefined) this.#records.delete(this.#queue);
      this.#queue = index;
    }
    if (typeof record.toolCallId === "string") {
      const replacesPartial = record.type === "tool_execution_start" ||
        (record.type === "tool_execution_update" && record.partialResult !== null &&
          typeof record.partialResult === "object");
      if (replacesPartial) {
        const previous = this.#partials.get(record.toolCallId);
        if (previous !== undefined) this.#records.delete(previous);
        this.#partials.delete(record.toolCallId);
        if (record.type === "tool_execution_update") this.#partials.set(record.toolCallId, index);
      }
    }
    // Keep the replacement at its actual arrival position. A prepend may
    // supply a missing tool start; updates that were initially ignored must
    // remain replayable. End events do not erase the last partial's details.
    this.#records.set(index, record);
  }

  records(): IterableIterator<EventRecord> {
    return this.#records.values();
  }
}

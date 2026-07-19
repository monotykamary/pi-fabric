import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonlPage } from "../src/log-tail.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("readJsonlPage", () => {
  it("returns bounded tail pages with stable older-page cursors", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-log-tail-"));
    roots.push(root);
    const file = path.join(root, "events.jsonl");
    fs.writeFileSync(
      file,
      Array.from({ length: 5 }, (_, index) => JSON.stringify({ index, text: `event-${index}` })).join("\n") + "\n",
    );

    const newest = readJsonlPage(file, 2);
    expect(newest.lines.map((line) => (line.parsed as { index: number }).index)).toEqual([3, 4]);
    expect(newest.lines.map((line) => line.parsed)).toEqual([
      { index: 3, text: "event-3" },
      { index: 4, text: "event-4" },
    ]);
    expect(newest.hasMore).toBe(true);
    expect(newest.before).toBe(newest.lines[0]!.offset);

    const older = readJsonlPage(file, 2, newest.before);
    expect(older.lines.map((line) => (line.parsed as { index: number }).index)).toEqual([1, 2]);
    expect(older.hasMore).toBe(true);
    expect(older.before).toBe(older.lines[0]!.offset);

    const oldest = readJsonlPage(file, 2, older.before);
    expect(oldest.lines.map((line) => (line.parsed as { index: number }).index)).toEqual([0]);
    expect(oldest).toMatchObject({ hasMore: false });
    expect(oldest.before).toBeUndefined();
  });

  it("reads a tail page that begins beyond the final file chunk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-log-tail-"));
    roots.push(root);
    const file = path.join(root, "events.jsonl");
    const records = Array.from({ length: 2_000 }, (_, index) => ({
      index,
      text: `event-${index}-${"x".repeat(80)}`,
    }));
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    const page = readJsonlPage(file, 3);
    expect(page.lines.map((line) => (line.parsed as { index: number }).index)).toEqual([1997, 1998, 1999]);
    expect(page.hasMore).toBe(true);
    const older = readJsonlPage(file, 3, page.before);
    expect(older.lines.map((line) => (line.parsed as { index: number }).index)).toEqual([1994, 1995, 1996]);
  });

  it("parses only complete records and preserves malformed lines as raw text", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-log-tail-"));
    roots.push(root);
    const file = path.join(root, "events.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ ok: true })}\nnot-json`);

    const page = readJsonlPage(file, 10);
    expect(page.lines).toEqual([
      { offset: 0, raw: JSON.stringify({ ok: true }), parsed: { ok: true } },
      { offset: JSON.stringify({ ok: true }).length + 1, raw: "not-json" },
    ]);
  });
});

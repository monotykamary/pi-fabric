import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abandonResidentRequest,
  sleepUnlessAborted,
} from "../src/residency/protocol.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("abandonResidentRequest", () => {
  it("removes the abandoned request and its late response, leaving siblings alone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-abandon-"));
    const requests = path.join(root, "requests");
    const responses = path.join(root, "responses");
    fs.mkdirSync(requests, { recursive: true });
    fs.mkdirSync(responses, { recursive: true });
    fs.writeFileSync(path.join(requests, "gone.json"), "{}");
    fs.writeFileSync(path.join(responses, "gone.json"), "{}");
    fs.writeFileSync(path.join(requests, "kept.json"), "{}");

    try {
      abandonResidentRequest(requests, responses, "gone");
      expect(fs.existsSync(path.join(requests, "gone.json"))).toBe(false);
      expect(fs.existsSync(path.join(responses, "gone.json"))).toBe(false);
      expect(fs.existsSync(path.join(requests, "kept.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never throws for missing files or directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-abandon-"));
    try {
      expect(() =>
        abandonResidentRequest(path.join(root, "no-requests"), path.join(root, "no-responses"), "absent"),
      ).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sleepUnlessAborted", () => {
  it("resolves after the interval without a signal", async () => {
    vi.useFakeTimers();
    const pending = sleepUnlessAborted(100);
    vi.advanceTimersByTime(100);
    await pending;
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(sleepUnlessAborted(1_000, controller.signal)).rejects.toThrow("stop");
  });

  it("wakes without waiting out the interval when aborted mid-sleep", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleepUnlessAborted(30_000, controller.signal);
    controller.abort(new Error("mid-sleep stop"));
    await expect(pending).rejects.toThrow("mid-sleep stop");
  });
});

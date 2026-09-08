import { describe, expect, it, vi } from "vitest";
import { PiModelControl } from "../src/worker/model-control.js";

const requested = "openai-codex/gpt-5.6-sol";
const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
const wrong = { provider: "runinfra", id: "glm-5-3-flash" };
const setup = (selector: string | undefined = requested, thinking: string | undefined = "high") => {
  const io = { send: vi.fn(), admitted: vi.fn(), observed: vi.fn(), fail: vi.fn() };
  const control = new PiModelControl("run", selector, thinking, io);
  const reply = (data?: unknown, success = true) => {
    const sent = io.send.mock.calls.at(-1)![0];
    control.observe({ type: "response", id: sent.id, command: sent.type, success, data, error: success ? undefined : "denied" });
  };
  control.start();
  return { control, io, reply };
};

const admit = (h: ReturnType<typeof setup>) => {
  h.reply(model);
  h.reply();
  h.reply({ model, thinkingLevel: "high" });
};

describe("Pi model admission", () => {
  it("reapplies selection and thinking before independently reading actual state", () => {
    const h = setup();
    expect(h.io.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "set_model", provider: model.provider, modelId: model.id }));
    expect(h.io.admitted).not.toHaveBeenCalled();
    h.reply(model);
    expect(h.io.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "set_thinking_level", level: "high" }));
    h.reply();
    expect(h.io.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "get_state" }));
    expect(h.io.admitted).not.toHaveBeenCalled();
    h.reply({ model, thinkingLevel: "high" });
    expect(h.control.ready).toBe(true);
    expect(h.io.admitted).toHaveBeenCalledExactlyOnceWith(requested, "high");
  });

  it("does not trust set_model's echoed model when extensions switch away again", () => {
    const h = setup();
    h.reply(model);
    h.reply();
    h.reply({ model: wrong });
    expect(h.io.admitted).not.toHaveBeenCalled();
    expect(h.io.observed).toHaveBeenCalledWith("runinfra/glm-5-3-flash");
    expect(h.io.fail).toHaveBeenCalledWith(expect.stringContaining("task was not sent"));
  });

  it.each([undefined, {}, { model: null }, { model }, { model, isStreaming: true }, { model, isCompacting: true }])("validates get_state %#", state => {
    const h = setup();
    h.reply(model);
    h.reply();
    h.reply(state);
    if (state?.model === model && !("isStreaming" in state) && !("isCompacting" in state)) {
      expect(h.control.ready).toBe(true);
    } else {
      expect(h.control.ready).toBe(false);
      expect(h.io.fail).toHaveBeenCalledOnce();
    }
  });

  it.each([0, 1, 2])("fails closed for rejected handshake command %s", stage => {
    const h = setup();
    for (let i = 0; i < stage; i++) h.reply(model);
    h.reply(undefined, false);
    expect(h.io.fail).toHaveBeenCalledOnce();
    expect(h.io.admitted).not.toHaveBeenCalled();
  });

  it("ignores unrelated and duplicate responses", () => {
    const h = setup();
    const first = h.io.send.mock.calls[0]![0];
    expect(h.control.observe({ type: "response", id: "other", command: "set_model", success: true })).toBe(false);
    h.reply(model);
    expect(h.control.observe({ type: "response", id: first.id, command: "set_model", success: true })).toBe(false);
    expect(h.io.send).toHaveBeenCalledTimes(2);
  });

  it("preserves model IDs containing slashes", () => {
    const h = setup("provider/org/model");
    expect(h.io.send).toHaveBeenCalledWith(expect.objectContaining({ provider: "provider", modelId: "org/model" }));
  });

  it("resolves a bare exact ID from the catalogue, not the active model", () => {
    const h = setup(model.id);
    expect(h.io.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "get_available_models" }));
    h.reply({ models: [wrong, model] });
    admit(h);
    expect(h.io.admitted).toHaveBeenCalledWith(requested, "high");
  });

  it.each([{ models: [] }, { models: [model, { ...model, provider: "other" }] }])("rejects missing/ambiguous bare IDs", ({ models }) => {
    const h = setup(model.id);
    h.reply({ models });
    expect(h.io.fail).toHaveBeenCalledOnce();
    expect(h.io.admitted).not.toHaveBeenCalled();
  });

  it("records unpinned attribution without enforcing a different model", () => {
    const io = { send: vi.fn(), admitted: vi.fn(), observed: vi.fn(), fail: vi.fn() };
    const control = new PiModelControl("run", undefined, undefined, io);
    control.start();
    control.observeAssistant({ role: "assistant", provider: wrong.provider, model: wrong.id });
    expect(io.observed).toHaveBeenCalledWith("runinfra/glm-5-3-flash");
    expect(io.fail).not.toHaveBeenCalled();
  });

  it.each([wrong, { provider: model.provider, id: "other" }, undefined])("fails on actual assistant model drift %#", actual => {
    const h = setup();
    admit(h);
    h.control.observeAssistant({ role: "assistant", provider: actual?.provider, model: actual?.id });
    expect(h.io.fail).toHaveBeenCalledOnce();
    expect(h.io.fail).toHaveBeenCalledWith(expect.stringContaining("terminating child"));
  });

  it("rejects assistant activity before admission and cannot later admit", () => {
    const h = setup();
    h.control.observeAssistant({ role: "assistant", provider: model.provider, model: model.id });
    h.reply(model);
    expect(h.io.fail).toHaveBeenCalledOnce();
    expect(h.io.admitted).not.toHaveBeenCalled();
  });
});

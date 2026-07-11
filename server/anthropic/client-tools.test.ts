import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessage, MAX_TOOL_ITERATIONS, __setClientForTest } from "./client.js";

// #27 stage 2 — the tool-use loop. createMessage must act on a tool_use block
// (today it filters to TextBlock and would return ""), loop while the model keeps
// asking, and TERMINATE at the iteration cap so an adversarial model cannot spin
// the loop forever (each turn multiplies Anthropic calls).

interface Block {
  type: string;
  [k: string]: unknown;
}
function fakeClient(script: { stop_reason: string; content: Block[] }[]) {
  let i = 0;
  const create = vi.fn(async () => {
    const r = script[Math.min(i++, script.length - 1)];
    return { ...r, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  return { client: { messages: { create } } as never, create };
}

beforeEach(() => {
  // Priceable model + no budget so assertWithinBudget/getClient never object.
  delete process.env.DISPATCH_DAILY_BUDGET_USD;
});
afterEach(() => __setClientForTest(null));

const toolUse = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x.ts" } }] };
const answer = { stop_reason: "end_turn", content: [{ type: "text", text: "the answer" }] };

describe("createMessage tool loop", () => {
  it("runs the tool then returns the model's final text (not an empty string)", async () => {
    const { client } = fakeClient([toolUse, answer]);
    __setClientForTest(client);
    const runTool = vi.fn(async () => "file contents");

    const out = await createMessage("sys", [{ role: "user", content: "explain x.ts" }], undefined, "chat", undefined, {
      tools: [{ name: "read_file", description: "", input_schema: { type: "object", properties: {} } }],
      runTool,
    });

    expect(runTool).toHaveBeenCalledWith("read_file", { path: "x.ts" });
    expect(out).toBe("the answer");
  });

  it("terminates at the iteration cap when the model never stops requesting tools", async () => {
    const { client, create } = fakeClient([toolUse]); // always tool_use
    __setClientForTest(client);
    const runTool = vi.fn(async () => "more");

    const out = await createMessage("sys", [{ role: "user", content: "loop" }], undefined, "chat", undefined, {
      tools: [{ name: "read_file", description: "", input_schema: { type: "object", properties: {} } }],
      runTool,
    });

    // It resolves (no hang), and never exceeds the cap of model calls.
    expect(typeof out).toBe("string");
    expect(create.mock.calls.length).toBeLessThanOrEqual(MAX_TOOL_ITERATIONS);
    expect(runTool.mock.calls.length).toBeLessThan(MAX_TOOL_ITERATIONS);
  });

  it("without tools, still returns text and ignores nothing (back-compat)", async () => {
    const { client } = fakeClient([answer]);
    __setClientForTest(client);
    const out = await createMessage("sys", [{ role: "user", content: "hi" }]);
    expect(out).toBe("the answer");
  });
});

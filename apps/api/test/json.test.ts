import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, parseWithRepair, parseWithSchema } from "../src/llm/json.js";
import { stripThink, ThinkStripper } from "../src/llm/strip.js";
import { rankModels } from "../src/llm/client.js";

const S = z.object({ a: z.number(), b: z.array(z.string()) });

describe("extractJson", () => {
  it("plain JSON", () => expect(extractJson('{"a":1,"b":["x"]}')).toEqual({ a: 1, b: ["x"] }));
  it("fenced JSON with prose around it", () =>
    expect(
      extractJson('Sure! Here is the plan:\n```json\n{"a": 2, "b": []}\n```\nHope that helps'),
    ).toEqual({ a: 2, b: [] }));
  it("think blocks before the JSON", () =>
    expect(extractJson('<think>I should output {"a": 9}</think>\n{"a":3,"b":["y"]}')).toEqual({
      a: 3,
      b: ["y"],
    }));
  it("trailing commas", () =>
    expect(extractJson('{"a":4,"b":["x","y",],}')).toEqual({ a: 4, b: ["x", "y"] }));
  it("braces inside strings do not confuse the balancer", () =>
    expect(extractJson('{"a":5,"b":["}{"]} trailing')).toEqual({ a: 5, b: ["}{"] }));
  it("truncated output is closed best-effort", () =>
    expect(extractJson('{"a":6,"b":["x","y')).toEqual({ a: 6, b: ["x", "y"] }));
  it("no object → throws", () => expect(() => extractJson("I cannot help")).toThrow());
});

describe("parseWithSchema / repair", () => {
  it("reports zod errors with paths", () => {
    const r = parseWithSchema('{"a":"nope","b":[]}', S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("a:");
  });
  it("repair path: one retry fixes it", async () => {
    let calls = 0;
    const r = await parseWithRepair('{"a":"bad"}', S, async (err) => {
      calls++;
      expect(err).toMatch(/a:|b:/);
      return '{"a":1,"b":[]}';
    });
    expect(calls).toBe(1);
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ a: 1, b: [] });
  });
  it("repair path: still invalid → null (caller uses safe fallback)", async () => {
    const r = await parseWithRepair("garbage", S, async () => "still garbage");
    expect(r.value).toBeNull();
  });
});

describe("think stripping", () => {
  it("removes closed, unclosed and orphan think blocks", () => {
    expect(stripThink("<think>hmm</think>Answer")).toBe("Answer");
    expect(stripThink("Answer<think>trailing thoughts")).toBe("Answer");
    expect(stripThink("leaked reasoning</think>Answer")).toBe("Answer");
  });
  it("streaming stripper handles tags split across chunks", () => {
    const s = new ThinkStripper();
    const chunks = [
      "<thi",
      "nk>secret ",
      "reasoning</th",
      "ink>\n\nHello ",
      "world <",
      "b>bold</b>",
    ];
    const out = chunks.map((c) => s.push(c)).join("") + s.flush();
    expect(out).toBe("Hello world <b>bold</b>");
  });
});

describe("rankModels", () => {
  it("keeps free DeepSeek ids, chat/V3 first (newest first), R1 last", () => {
    const ids = [
      "deepseek/deepseek-r1:free",
      "deepseek/deepseek-chat-v3-0324:free",
      "openai/gpt-4o",
      "deepseek/deepseek-chat-v3.1:free",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-r1-0528:free",
      "deepseek/deepseek-prover-v2:free",
    ];
    const r = rankModels(ids);
    expect(r[0]).toBe("deepseek/deepseek-chat-v3.1:free");
    expect(r[1]).toBe("deepseek/deepseek-chat-v3-0324:free");
    expect(r.slice(2, 4).every((m) => m.includes("r1"))).toBe(true);
    expect(r).not.toContain("deepseek/deepseek-chat");
    expect(r.at(-1)).toContain("prover");
  });
});

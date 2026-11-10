import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/pipeline/memory.js";
import { SearchService } from "../src/pipeline/search.js";
import { runChat, type Deps } from "../src/pipeline/orchestrator.js";
import { DownLlm, FakeSearchProvider, ScriptedLlm } from "../src/testing/fakes.js";
import { silentLogger } from "../src/util/logger.js";
import type { SseEvent } from "../src/util/sse.js";
import type { CompleteOptions } from "../src/llm/client.js";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-10T16:52:00Z");
const CLIENT = "33333333-3333-4333-8333-333333333333";
const CRMS = ["HubSpot", "Pipedrive", "Zoho CRM", "Freshsales", "Salesforce Starter"];

let mem: MemoryStore;
beforeEach(() => {
  mem = new MemoryStore(":memory:");
});

function seedMonday() {
  const conv = mem.createConversation(CLIENT, "CRM shortlist", new Date("2026-11-09T05:35:00Z"));
  mem.addMessage({
    conversationId: conv.id,
    clientId: CLIENT,
    role: "user",
    content: "Shortlist CRM tools for our 20-person sales team",
    tz: TZ,
    createdAt: "2026-11-09T05:35:00Z",
  });
  mem.addMessage({
    conversationId: conv.id,
    clientId: CLIENT,
    role: "assistant",
    content: `Shortlist: ${CRMS.join(", ")}.`,
    tz: TZ,
    createdAt: "2026-11-09T05:35:30Z",
  });
}

function deps(
  llm: Deps["llm"],
  provider = new FakeSearchProvider(),
): Deps & { provider: FakeSearchProvider } {
  return {
    llm,
    search: new SearchService(provider),
    memory: mem,
    log: silentLogger,
    maxSearchCalls: 12,
    now: () => NOW,
    provider,
  };
}

async function run(d: Deps, message: string, signal = new AbortController().signal) {
  const events: SseEvent[] = [];
  const out = await runChat(
    d,
    { requestId: "t", clientId: CLIENT, conversationId: null, message, tz: TZ, signal },
    (e) => events.push(e),
  );
  return { out, events };
}

const planJson = (o: Record<string, unknown>) =>
  JSON.stringify({
    intent: "change_since",
    needs_search: true,
    baseline: { date: null, basis: "none" },
    entities: [],
    queries: [],
    clarify: null,
    assumptions: [],
    ...o,
  });

describe("orchestrator", () => {
  it("history case: recalls Monday, sets deterministic baseline, searches per entity, cites, persists", async () => {
    seedMonday();
    const llm = new ScriptedLlm((o: CompleteOptions) => {
      if (o.purpose === "planner")
        return planJson({
          entities: CRMS,
          queries: CRMS.map((e) => ({
            q: `${e} pricing update`,
            topic: "news",
            time_range: null,
            start_date: null,
            include_domains: null,
            entity: e,
          })),
        });
      return "2 of 5 changed pricing since Mon 9 Nov [1][3]; others show no evidence of change [2]. (Monday = Mon 9 Nov 2026)";
    });
    const d = deps(llm);
    const { out, events } = await run(
      d,
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    );

    expect(events[0]!.type).toBe("conversation");
    expect(events[1]!.type).toBe("status");
    expect(out.timings.first_status_ms).toBeLessThan(300);
    expect(out.plan?.baseline).toEqual({ date: "2026-11-09T05:35:00.000Z", basis: "history" });
    expect(out.plan?.entities).toEqual(CRMS);
    expect(out.plan?.assumptions.join(" ")).toContain("Mon 9 Nov 2026");
    // news queries inherit start_date = baseline local date
    expect(d.provider.calls.every((c) => c.start_date === "2026-11-09")).toBe(true);
    expect(out.searchCalls).toBe(5);
    expect(llm.calls).toHaveLength(2); // plan + synth
    const types = events.map((e) => e.type);
    expect(types.indexOf("plan")).toBeLessThan(types.indexOf("search"));
    expect(types.indexOf("token")).toBeLessThan(types.indexOf("sources"));
    expect(types.at(-1)).toBe("done");
    const src = events.find((e) => e.type === "sources");
    expect(src && src.type === "sources" && src.sources.map((s) => s.n)).toEqual([1, 2, 3]);
    const stored = mem.getMessages(CLIENT, out.conversationId).at(-1)!;
    expect(stored.role).toBe("assistant");
    expect(JSON.parse(stored.sources_json!)).toHaveLength(3);
    expect(JSON.parse(stored.plan_json!).intent).toBe("change_since");
  });

  it("no-history case: planner's invented entities are not treated as the user's list", async () => {
    const llm = new ScriptedLlm((o) =>
      o.purpose === "planner"
        ? planJson({
            entities: ["HubSpot", "Pipedrive"],
            queries: [
              {
                q: "CRM pricing changes",
                topic: "news",
                time_range: null,
                start_date: null,
                include_domains: null,
                entity: null,
              },
            ],
            clarify: "Which 5 tools were on the shortlist?",
          })
        : "I don't have a record of a conversation on Mon 9 Nov. Which 5 tools were on it? [1]",
    );
    const { out } = await run(
      deps(llm),
      "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?",
    );
    expect(out.plan?.entities).toEqual([]);
    expect(out.plan?.example_entities).toEqual(["HubSpot", "Pipedrive"]);
    expect(out.plan?.baseline.basis).toBe("user_message");
    const synthPrompt = llm.calls.at(-1)!.messages[1]!.content;
    expect(synthPrompt).toContain('NO RECORDS FOUND for: "Monday" = Mon 9 Nov 2026');
    expect(synthPrompt).toContain("EXAMPLE entities");
  });

  it("chit-chat fast path: no planner call, no search", async () => {
    const llm = new ScriptedLlm(() => "You're welcome!");
    const d = deps(llm);
    const { out } = await run(d, "thanks!");
    expect(out.planSource).toBe("fast_path");
    expect(out.searchCalls).toBe(0);
    expect(d.provider.calls).toHaveLength(0);
    expect(llm.calls).toHaveLength(1);
  });

  it("planner garbage twice → safe fallback plan (search the message)", async () => {
    const llm = new ScriptedLlm((o) => (o.purpose === "synth" ? "Answer [1]" : "not json at all"));
    const d = deps(llm);
    const { out } = await run(d, "latest postgres version");
    expect(out.planSource).toBe("fallback");
    expect(llm.calls.filter((c) => c.purpose === "repair")).toHaveLength(1);
    expect(d.provider.calls[0]!.q).toBe("latest postgres version");
  });

  it("one reformulation round max when a query returns nothing", async () => {
    const provider = new FakeSearchProvider((p) =>
      p.q.includes("obscure")
        ? []
        : [
            {
              title: "t",
              url: `https://x.com/${p.q.length}`,
              content: "c",
              published_date: null,
              score: 0.5,
            },
          ],
    );
    const llm = new ScriptedLlm((o) => {
      if (o.purpose === "planner")
        return planJson({
          intent: "factual",
          queries: [
            {
              q: "obscure thing",
              topic: "general",
              time_range: null,
              start_date: null,
              include_domains: null,
              entity: null,
            },
          ],
        });
      if (o.purpose === "reformulate")
        return JSON.stringify({
          queries: [
            {
              q: "obscure thing alt",
              topic: "general",
              time_range: null,
              start_date: null,
              include_domains: null,
              entity: null,
            },
          ],
        });
      return "No luck.";
    });
    const d = deps(llm, provider);
    await run(d, "tell me about the obscure thing");
    expect(llm.calls.filter((c) => c.purpose === "reformulate")).toHaveLength(1);
    expect(provider.calls.map((c) => c.depth)).toEqual(["basic", "advanced"]);
  });

  it("all models rate-limited → friendly retryable error event, nothing thrown", async () => {
    const { events, out } = await run(deps(new DownLlm()), "what's new in Node.js?");
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.retryable).toBe(true);
    expect(err && err.type === "error" && err.message).toMatch(/busy|rate-limited/);
    expect(out.error).not.toBeNull();
  });

  it("client abort → no error event and no assistant message persisted", async () => {
    const ctrl = new AbortController();
    const llm = new ScriptedLlm((o) => {
      if (o.purpose === "planner") ctrl.abort();
      return planJson({ intent: "factual" });
    });
    const { events, out } = await run(deps(llm), "something", ctrl.signal);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(
      mem.getMessages(CLIENT, out.conversationId).filter((m) => m.role === "assistant"),
    ).toHaveLength(0);
  });
});

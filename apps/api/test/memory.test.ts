import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  keyTerms,
  renderMemory,
  baselineFromRecall,
  noRecordRanges,
} from "../src/pipeline/memory.js";
import { resolveDates } from "../src/pipeline/temporal.js";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-10T16:52:00Z"); // Tue 10 Nov 22:22 IST
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let mem: MemoryStore;

function seedTurn(client: string, at: string, q: string, a: string, title = "t") {
  const conv = mem.createConversation(client, title, new Date(at));
  mem.addMessage({
    conversationId: conv.id,
    clientId: client,
    role: "user",
    content: q,
    tz: TZ,
    createdAt: at,
  });
  mem.addMessage({
    conversationId: conv.id,
    clientId: client,
    role: "assistant",
    content: a,
    tz: TZ,
    createdAt: new Date(Date.parse(at) + 20_000).toISOString(),
    sources: [
      {
        n: 1,
        title: "HubSpot pricing",
        url: "https://www.hubspot.com/pricing",
        published_date: null,
        retrieved_at: at,
      },
    ],
  });
  return conv;
}

beforeEach(() => {
  mem = new MemoryStore(":memory:");
  // Mon 9 Nov 11:05 IST
  seedTurn(
    A,
    "2026-11-09T05:35:00Z",
    "Shortlist CRM tools for a 20-person sales team",
    "HubSpot, Pipedrive, Zoho CRM, Freshsales, Salesforce Starter",
    "CRM shortlist",
  );
  // Tue 3 Nov 16:40 IST
  seedTurn(
    A,
    "2026-11-03T11:10:00Z",
    "Compare Postgres hosting pricing: Neon, Supabase, RDS",
    "Neon from $5…, Supabase Pro $25…",
    "Postgres hosting",
  );
  // Client B has a CRM conversation on Monday too — must never leak to A.
  seedTurn(
    B,
    "2026-11-09T06:00:00Z",
    "Best CRM for B's secret project Zephyr",
    "Zephyr CRM answer",
    "B secret",
  );
});
afterEach(() => mem.close());

describe("memory", () => {
  it("retrieves turns inside a resolved range, paired Q/A, with sources", () => {
    const ranges = resolveDates("On Monday we shortlisted 5 CRM tools", NOW, TZ);
    const r = mem.recall({
      clientId: A,
      conversationId: null,
      ranges,
      query: "On Monday we shortlisted 5 CRM tools",
      tz: TZ,
    });
    expect(r.ranges[0]!.turns).toHaveLength(1);
    const t = r.ranges[0]!.turns[0]!;
    expect(t.user?.content).toContain("20-person");
    expect(t.assistant?.content).toContain("Pipedrive");
    expect(baselineFromRecall(r)).toBe("2026-11-09T05:35:00.000Z");
    const { pastBlock } = renderMemory(r, TZ);
    expect(pastBlock).toContain("Mon 9 Nov 2026 11:05");
    expect(pastBlock).toContain("https://www.hubspot.com/pricing");
  });

  it("marks NO RECORDS FOUND for empty ranges", () => {
    const ranges = resolveDates("what did I ask you yesterday?", NOW, TZ); // yesterday = Mon 9 Nov
    const r0 = mem.recall({ clientId: A, conversationId: null, ranges, query: "", tz: TZ });
    expect(r0.ranges[0]!.turns).toHaveLength(1);
    const empty = resolveDates("what did I ask you on 1 October?", NOW, TZ);
    const r = mem.recall({
      clientId: A,
      conversationId: null,
      ranges: empty,
      query: "what did I ask you",
      tz: TZ,
    });
    expect(noRecordRanges(r)).toHaveLength(1);
    expect(renderMemory(r, TZ).pastBlock).toContain(
      'NO RECORDS FOUND for "on 1 October" (Thu 1 Oct 2026)',
    );
  });

  it("FTS fallback finds keyword matches globally when no dates are given", () => {
    const r = mem.recall({
      clientId: A,
      conversationId: null,
      ranges: [],
      query: "remind me what you said about postgres hosting",
      tz: TZ,
    });
    expect(r.keywordTurns.map((t) => t.conversationTitle)).toEqual(["Postgres hosting"]);
  });

  it("FTS is restricted to ±3 days around the range", () => {
    const ranges = resolveDates("on 20 October", NOW, TZ);
    const r = mem.recall({
      clientId: A,
      conversationId: null,
      ranges,
      query: "postgres hosting on 20 October",
      tz: TZ,
    });
    expect(r.keywordTurns).toHaveLength(0);
    const near = resolveDates("on 5 November", NOW, TZ); // 2 days after 3 Nov
    const r2 = mem.recall({
      clientId: A,
      conversationId: null,
      ranges: near,
      query: "postgres hosting",
      tz: TZ,
    });
    expect(r2.keywordTurns).toHaveLength(1);
  });

  it("per-client isolation: client A never sees client B's rows (ranges, FTS, lists)", () => {
    const ranges = resolveDates("Monday", NOW, TZ);
    const r = mem.recall({
      clientId: A,
      conversationId: null,
      ranges,
      query: "Zephyr secret project CRM",
      tz: TZ,
    });
    const all = JSON.stringify(r);
    expect(all).not.toContain("Zephyr");
    expect(mem.listConversations(A).map((c) => c.title)).not.toContain("B secret");
    const bConv = mem.listConversations(B)[0]!;
    expect(mem.getConversation(A, bConv.id)).toBeNull();
    expect(mem.getMessages(A, bConv.id)).toEqual([]);
    expect(mem.deleteConversation(A, bConv.id)).toBe(false);
    expect(mem.getMessages(B, bConv.id)).toHaveLength(2);
  });

  it("recent messages of the current conversation are always included, excluding the current message", () => {
    const conv = mem.listConversations(A).find((c) => c.title === "CRM shortlist")!;
    const cur = mem.addMessage({
      conversationId: conv.id,
      clientId: A,
      role: "user",
      content: "make that shorter",
      tz: TZ,
      createdAt: NOW,
    });
    const r = mem.recall({
      clientId: A,
      conversationId: conv.id,
      ranges: [],
      query: "make that shorter",
      tz: TZ,
      excludeMessageIds: [cur.id],
    });
    expect(r.recent).toHaveLength(2);
    expect(r.recent.map((m) => m.id)).not.toContain(cur.id);
  });

  it("knownDates lists most recent days with records", () => {
    expect(mem.knownDates(A, TZ)).toEqual(["Mon 9 Nov 2026", "Tue 3 Nov 2026"]);
  });

  it("deleting a conversation removes it from FTS as well", () => {
    const conv = mem.listConversations(A).find((c) => c.title === "Postgres hosting")!;
    expect(mem.deleteConversation(A, conv.id)).toBe(true);
    const r = mem.recall({
      clientId: A,
      conversationId: null,
      ranges: [],
      query: "postgres hosting",
      tz: TZ,
    });
    expect(r.keywordTurns).toHaveLength(0);
  });

  it("keyTerms drops stopwords and date words", () => {
    expect(
      keyTerms(
        "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
      ),
    ).toEqual(["postgres", "hosting", "pricing"]);
  });

  it("memory block is size-capped", () => {
    const conv = mem.createConversation(A, "big", new Date("2026-11-09T07:00:00Z"));
    for (let i = 0; i < 40; i++) {
      mem.addMessage({
        conversationId: conv.id,
        clientId: A,
        role: i % 2 ? "assistant" : "user",
        content: "x".repeat(3000),
        tz: TZ,
        createdAt: new Date(Date.parse("2026-11-09T07:00:00Z") + i * 1000),
      });
    }
    const r = mem.recall({
      clientId: A,
      conversationId: null,
      ranges: resolveDates("Monday", NOW, TZ),
      query: "",
      tz: TZ,
    });
    expect(renderMemory(r, TZ).pastBlock.length).toBeLessThan(12_500);
  });
});

describe("keyTerms tokenization", () => {
  it("splits dotted names like FTS5 does", () => {
    expect(keyTerms("what changed in Node.js pricing")).toEqual(["node", "pricing"]);
  });
});

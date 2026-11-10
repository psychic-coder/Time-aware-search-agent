/**
 * `npm run seed` — creates a demo client with realistic, BACKDATED history (relative to now):
 *   - "Monday"          : 5-CRM shortlist for a 20-person sales team, with a pricing answer + sources
 *   - 7 days ago        : a verifiable question (latest stable Python) with a dated answer
 *   - "last Tuesday"    : Postgres hosting pricing (Neon, Supabase, Amazon RDS, Render)
 * The seeded answers are illustrative demo data written "as of" their timestamps.
 */
import { pathToFileURL } from "node:url";
import { DateTime } from "luxon";
import { DEFAULT_DB_PATH } from "../src/config.js";
import { MemoryStore, type StoredSource } from "../src/pipeline/memory.js";
import { resolveDates } from "../src/pipeline/temporal.js";

export const DEMO_CLIENT_ID = "de300000-0000-4000-8000-000000000001";

function at(dayStartIso: string, tz: string, hh: number, mm: number): DateTime {
  return DateTime.fromISO(dayStartIso)
    .setZone(tz)
    .set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
}

function addTurn(
  mem: MemoryStore,
  clientId: string,
  tz: string,
  when: DateTime,
  title: string,
  q: string,
  a: string,
  sources: Omit<StoredSource, "retrieved_at">[],
): void {
  const conv = mem.createConversation(clientId, title, when.toJSDate());
  mem.addMessage({
    conversationId: conv.id,
    clientId,
    role: "user",
    content: q,
    tz,
    createdAt: when.toJSDate(),
  });
  const answeredAt = when.plus({ seconds: 14 });
  mem.addMessage({
    conversationId: conv.id,
    clientId,
    role: "assistant",
    content: a,
    tz,
    createdAt: answeredAt.toJSDate(),
    plan: { intent: "seeded_demo" },
    sources: sources.map((s) => ({ ...s, retrieved_at: answeredAt.toUTC().toISO() as string })),
  });
}

export function seedDemo(
  mem: MemoryStore,
  opts: { clientId?: string; now?: Date; tz?: string } = {},
): { clientId: string; turns: { title: string; at: string }[] } {
  const clientId = opts.clientId ?? DEMO_CLIENT_ID;
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? "Asia/Kolkata";

  // idempotent: wipe this client's rows first
  for (const c of mem.listConversations(clientId, 1000)) mem.deleteConversation(clientId, c.id);

  const monday = resolveDates("Monday", now, tz)[0]!;
  const lastTue = resolveDates("last Tuesday", now, tz)[0]!;
  const sevenAgo = resolveDates("7 days ago", now, tz)[0]!;

  const t1 = at(monday.start, tz, 11, 5);
  addTurn(
    mem,
    clientId,
    tz,
    t1,
    "CRM shortlist for a 20-person sales team",
    "We're a 20-person B2B sales team moving off spreadsheets. Shortlist 5 CRM tools and compare per-seat pricing.",
    [
      `Here's a shortlist of 5 CRMs that fit a 20-seat sales team, with entry pricing for the sales-focused tier (per user/month, billed annually, as listed on ${t1.toFormat("d LLL yyyy")}):`,
      "",
      "| CRM | Tier to start with | List price | Notes |",
      "|---|---|---|---|",
      "| HubSpot Sales Hub | Starter | ~$15–20/seat [1] | Strong free CRM core; Professional jumps sharply |",
      "| Pipedrive | Growth (formerly Advanced) | ~$34/seat [2] | Pipeline-first UI, quick to adopt |",
      "| Zoho CRM | Standard | ~$14/seat [3] | Cheapest full-featured option |",
      "| Freshsales | Growth | ~$9/seat [4] | Built-in phone/email |",
      "| Salesforce Starter | Starter Suite | $25/seat [5] | Easiest path to full Salesforce later |",
      "",
      "For 20 seats: Zoho or Freshsales is the low-cost pick; HubSpot or Pipedrive if adoption speed matters most.",
    ].join("\n"),
    [
      {
        n: 1,
        title: "HubSpot Sales Hub pricing",
        url: "https://www.hubspot.com/pricing/sales",
        published_date: null,
      },
      {
        n: 2,
        title: "Pipedrive pricing",
        url: "https://www.pipedrive.com/en/pricing",
        published_date: null,
      },
      {
        n: 3,
        title: "Zoho CRM pricing",
        url: "https://www.zoho.com/crm/zohocrm-pricing.html",
        published_date: null,
      },
      {
        n: 4,
        title: "Freshsales pricing",
        url: "https://www.freshworks.com/crm/pricing/",
        published_date: null,
      },
      {
        n: 5,
        title: "Salesforce Starter Suite pricing",
        url: "https://www.salesforce.com/editions-pricing/small-business/",
        published_date: null,
      },
    ],
  );

  const t2 = at(sevenAgo.start, tz, 10, 15);
  addTurn(
    mem,
    clientId,
    tz,
    t2,
    "Latest stable Python version",
    "What's the latest stable Python release, and when is the next one due?",
    "The latest stable release is **Python 3.14** (first released 7 Oct 2025) [1]. Python ships a new feature release every October, so **3.15** is scheduled for October 2026 [2]. Python 3.9 reached end-of-life in October 2025 [2].",
    [
      {
        n: 1,
        title: "Python Release Python 3.14.0",
        url: "https://www.python.org/downloads/release/python-3140/",
        published_date: "2025-10-07",
      },
      {
        n: 2,
        title: "PEP 790 – Python 3.15 Release Schedule",
        url: "https://peps.python.org/pep-0790/",
        published_date: null,
      },
    ],
  );

  const t3 = at(lastTue.start, tz, 16, 40);
  addTurn(
    mem,
    clientId,
    tz,
    t3,
    "Postgres hosting pricing",
    "Compare managed Postgres hosting pricing for a small production app: Neon, Supabase, Amazon RDS, Render.",
    [
      `Entry paid tiers for a small production Postgres (as of ${t3.toFormat("d LLL yyyy")}):`,
      "",
      "| Provider | Entry paid plan | Price | Notes |",
      "|---|---|---|---|",
      "| Neon | Launch | usage-based, from ~$5/mo [1] | Serverless, scale-to-zero, branching |",
      "| Supabase | Pro | $25/mo incl. compute credits [2] | Postgres + auth + storage bundle |",
      "| Amazon RDS for PostgreSQL | db.t4g.micro on-demand | ~$12–15/mo + storage [3] | Most control, most ops |",
      "| Render | Basic-256mb | ~$6/mo + storage [4] | Simple, predictable |",
      "",
      "For a small app with spiky traffic Neon is cheapest; Supabase if you also want auth/storage.",
    ].join("\n"),
    [
      { n: 1, title: "Neon pricing", url: "https://neon.com/pricing", published_date: null },
      {
        n: 2,
        title: "Supabase pricing",
        url: "https://supabase.com/pricing",
        published_date: null,
      },
      {
        n: 3,
        title: "Amazon RDS for PostgreSQL pricing",
        url: "https://aws.amazon.com/rds/postgresql/pricing/",
        published_date: null,
      },
      { n: 4, title: "Render pricing", url: "https://render.com/pricing", published_date: null },
    ],
  );

  return {
    clientId,
    turns: [t1, t2, t3].map((t, i) => ({
      title: ["CRM shortlist", "Python release", "Postgres hosting"][i] as string,
      at: t.toFormat("ccc d LLL yyyy HH:mm ZZZZ"),
    })),
  };
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const tz =
    process.env.SEED_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
  const mem = new MemoryStore(dbPath);
  const r = seedDemo(mem, { tz });
  mem.close();
  console.log(`Seeded demo history into ${dbPath} (timezone ${tz}):`);
  for (const t of r.turns) console.log(`  - ${t.at}  ${t.title}`);
  console.log(
    `\nOpen the demo identity in the browser:\n  http://localhost:3000/?client=${r.clientId}\n`,
  );
}

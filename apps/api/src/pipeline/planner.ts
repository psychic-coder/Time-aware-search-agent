/**
 * Stage 3 — planner: one LLM call (temperature 0, JSON) + deterministic guardrails.
 * The LLM proposes; code enforces the invariants we can't afford to get wrong
 * (baseline date, entity grounding, query caps, stated date assumptions).
 */
import { z } from "zod";
import { DateTime } from "luxon";
import type { Llm } from "../llm/client.js";
import { parseWithRepair, parseWithSchema } from "../llm/json.js";
import { PLANNER_REPAIR, PLANNER_SYSTEM, REFORMULATE_SYSTEM } from "./prompts.js";
import { renderResolvedDates, type ResolvedDate } from "./temporal.js";
import { baselineFromRecall, type RecallResult } from "./memory.js";
import type { PlannedQuery } from "./search.js";
import { describeNow } from "../util/time.js";
import type { Logger } from "../util/logger.js";

export const INTENTS = [
  "chitchat",
  "factual",
  "current_info",
  "change_since",
  "recall_past",
  "recheck_past_answer",
  "comparison",
] as const;

const QuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  topic: z.enum(["general", "news"]).catch("general"),
  time_range: z.enum(["day", "week", "month", "year"]).nullable().catch(null).default(null),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .catch(null)
    .default(null),
  include_domains: z.array(z.string()).max(5).nullable().catch(null).default(null),
  entity: z.string().max(80).nullable().catch(null).default(null),
});

export const PlanSchema = z.object({
  intent: z.enum(INTENTS),
  needs_search: z.boolean(),
  baseline: z
    .object({
      date: z.string().nullable().catch(null),
      basis: z.enum(["history", "user_message", "none"]).catch("none"),
    })
    .default({ date: null, basis: "none" }),
  entities: z.array(z.string().max(80)).max(20).default([]),
  queries: z.array(QuerySchema).max(12).default([]),
  clarify: z.string().max(300).nullable().default(null),
  assumptions: z.array(z.string().max(300)).max(10).default([]),
});
export type LlmPlan = z.infer<typeof PlanSchema>;

export interface Plan extends Omit<LlmPlan, "queries"> {
  queries: PlannedQuery[];
  /** Entities the planner proposed that do not appear in memory or the message (e.g. default providers). */
  example_entities: string[];
}

export interface PlanContext {
  now: Date;
  tz: string;
  userMessage: string;
  dates: ResolvedDate[];
  recall: RecallResult;
  pastBlock: string;
  recentBlock: string;
}

export type PlanSource = "llm" | "repaired" | "fallback" | "fast_path";

/* ------------------------------ fast path ------------------------------ */

const CHITCHAT_RE = new RegExp(
  "^(?:(?:hi|hello|hey|yo|good (?:morning|afternoon|evening|night)|bye|goodbye)|" +
    "(?:thanks?(?: you)?|thx|ty|cheers|ok(?:ay)?|cool|great|nice|perfect|awesome|got it)(?:\\s+(?:so much|a lot|again|man))?" +
    "(?:[\\s,!.]+(?:that|this|it)(?:'s|\\s+was|\\s+is)\\s+(?:very\\s+|really\\s+|super\\s+)?(?:helpful|great|perfect|useful|clear|awesome|nice|good))?)" +
    "[\\s!.,:)]*$",
  "i",
);
const REWRITE_RE =
  /^(?:(?:can you |please )?(?:make|keep) (?:it|that|this) (?:shorter|longer|simpler|briefer|more concise|a table|into a table|bullet(?:ed|s)?)|shorter|more concise|simplify|summari[sz]e (?:it|that|this)|tl;?dr|rephrase(?: that| it)?|(?:as|in) (?:a table|bullets?|bullet points))[\s!.?]*$/i;

/** Deterministic no-search path: saves a full LLM round trip (~1-3 s) for obvious chit-chat/rewrites. */
export function fastPathPlan(message: string, hasPreviousAnswer: boolean): Plan | null {
  const m = message.trim();
  if (CHITCHAT_RE.test(m) || (hasPreviousAnswer && REWRITE_RE.test(m))) {
    return {
      intent: "chitchat",
      needs_search: false,
      baseline: { date: null, basis: "none" },
      entities: [],
      queries: [],
      clarify: null,
      assumptions: [],
      example_entities: [],
    };
  }
  return null;
}

/* ------------------------------ prompt ------------------------------ */

export function plannerUserContent(ctx: PlanContext): string {
  const baseline = baselineFromRecall(ctx.recall);
  return [
    `<now>${describeNow(ctx.now, ctx.tz)}; today's ISO date: ${DateTime.fromJSDate(ctx.now).setZone(ctx.tz).toISODate()}</now>`,
    `<resolved_dates>\n${renderResolvedDates(ctx.dates)}\n</resolved_dates>`,
    `<deterministic_baseline>${baseline ? `${baseline} (timestamp of the matching past turn)` : "none"}</deterministic_baseline>`,
    ctx.pastBlock,
    ctx.recentBlock,
    `<user_message>\n${ctx.userMessage}\n</user_message>`,
    "Return the JSON plan now.",
  ].join("\n\n");
}

/* ------------------------------ guardrails ------------------------------ */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function grounded(entity: string, haystack: string): boolean {
  const e = norm(entity);
  if (!e) return false;
  if (haystack.includes(e)) return true;
  // "Zoho CRM" grounded by "zoho"; "Amazon RDS" by "rds" — any distinctive token ≥3 chars.
  return e
    .split(" ")
    .some(
      (tok) =>
        tok.length >= 3 &&
        !["crm", "the", "inc", "pro", "cloud", "suite"].includes(tok) &&
        haystack.includes(` ${tok} `),
    );
}

function hostname(d: string): string | null {
  const s = d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

export function postProcessPlan(raw: LlmPlan, ctx: PlanContext): Plan {
  const haystack = ` ${norm([ctx.pastBlock, ctx.recentBlock, ctx.userMessage].join(" "))} `;
  const entities = [...new Set(raw.entities.map((e) => e.trim()).filter(Boolean))];
  const groundedEntities = entities.filter((e) => grounded(e, haystack));
  const example = entities.filter((e) => !grounded(e, haystack));

  const assumptions = [...raw.assumptions];
  if (example.length && !assumptions.some((a) => /example|commonly|default/i.test(a))) {
    assumptions.push(
      `${example.join(", ")} are commonly compared examples, not names from the user's record.`,
    );
  }

  // Deterministic baseline: history beats the model; then the resolved date; else the model's (if parseable).
  const histBaseline = baselineFromRecall(ctx.recall);
  const todayStart = DateTime.fromJSDate(ctx.now)
    .setZone(ctx.tz)
    .startOf("day")
    .toUTC()
    .toISO() as string;
  const firstPast = ctx.dates.find((d) => Date.parse(d.start) < Date.parse(todayStart));
  let baseline: Plan["baseline"];
  if (histBaseline) baseline = { date: histBaseline, basis: "history" };
  else if (firstPast && ["change_since", "recheck_past_answer", "recall_past"].includes(raw.intent))
    baseline = { date: firstPast.start, basis: "user_message" };
  else if (raw.baseline.date && !Number.isNaN(Date.parse(raw.baseline.date)))
    baseline = raw.baseline;
  else baseline = { date: null, basis: "none" };

  const today = DateTime.fromJSDate(ctx.now).setZone(ctx.tz).toISODate() as string;
  const baselineLocal = baseline.date
    ? DateTime.fromISO(baseline.date).setZone(ctx.tz).toISODate()
    : null;

  const seen = new Set<string>();
  let queries: PlannedQuery[] = [];
  if (raw.needs_search) {
    for (const q of raw.queries) {
      const text = q.q.replace(/\s+/g, " ").trim().slice(0, 120);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      let start = q.start_date && q.start_date <= today ? q.start_date : null;
      if (!start && q.topic === "news" && raw.intent === "change_since" && baselineLocal)
        start = baselineLocal;
      const domains = (q.include_domains ?? [])
        .map(hostname)
        .filter((d): d is string => d !== null);
      queries.push({
        q: text,
        topic: q.topic,
        time_range: start ? null : q.time_range,
        start_date: start,
        include_domains: domains.length ? domains : null,
        entity: q.entity?.trim() || null,
      });
    }
    queries = queries.slice(0, 8);
    if (queries.length === 0) queries = [fallbackQuery(ctx.userMessage)];
  }

  // Always surface how relative dates were read (first, so they are never truncated), so the user can correct us.
  const dateNotes = ctx.dates
    .filter((d) => !assumptions.some((a) => a.includes(d.label)))
    .map((d) => `Interpreted "${d.phrase}" as ${d.label}${d.ambiguous ? " (ambiguous)" : ""}.`);
  assumptions.unshift(...dateNotes);

  return {
    intent: raw.intent,
    needs_search: raw.needs_search && queries.length > 0,
    baseline,
    entities: groundedEntities,
    example_entities: example,
    queries,
    clarify: raw.clarify?.trim() || null,
    assumptions: assumptions.slice(0, 8),
  };
}

function fallbackQuery(message: string): PlannedQuery {
  return {
    q: message.replace(/\s+/g, " ").trim().slice(0, 200),
    topic: "general",
    time_range: null,
    start_date: null,
    include_domains: null,
    entity: null,
  };
}

/** Safe plan when the model output is unusable twice. */
export function fallbackPlan(ctx: PlanContext): Plan {
  const raw: LlmPlan = {
    intent: ctx.recall.ranges.length ? "recall_past" : "factual",
    needs_search: true,
    baseline: { date: null, basis: "none" },
    entities: [],
    queries: [{ ...fallbackQuery(ctx.userMessage), entity: null }],
    clarify: null,
    assumptions: [],
  };
  return postProcessPlan(raw, ctx);
}

/* ------------------------------ LLM calls ------------------------------ */

export async function makePlan(
  llm: Llm,
  ctx: PlanContext,
  opts: { signal?: AbortSignal; log: Logger },
): Promise<{ plan: Plan; source: PlanSource; models: string[] }> {
  const fast = fastPathPlan(
    ctx.userMessage,
    ctx.recall.recent.some((m) => m.role === "assistant"),
  );
  if (fast) return { plan: fast, source: "fast_path", models: [] };

  const messages = [
    { role: "system" as const, content: PLANNER_SYSTEM },
    { role: "user" as const, content: plannerUserContent(ctx) },
  ];
  const models: string[] = [];
  const first = await llm.complete({
    messages,
    temperature: 0,
    maxTokens: 700,
    timeoutMs: 12_000,
    signal: opts.signal,
    purpose: "planner",
  });
  models.push(first.model);

  const result = await parseWithRepair(first.text, PlanSchema, async (error, previous) => {
    opts.log.warn("planner output invalid, repairing", { error });
    const fix = await llm.complete({
      messages: [
        ...messages,
        { role: "assistant", content: previous.slice(0, 4000) },
        { role: "user", content: PLANNER_REPAIR.replace("{{error}}", error) },
      ],
      temperature: 0,
      maxTokens: 700,
      timeoutMs: 12_000,
      signal: opts.signal,
      purpose: "repair",
    });
    models.push(fix.model);
    return fix.text;
  });

  if (!result.value) {
    opts.log.warn("planner fell back to safe plan", { error: result.error });
    return { plan: fallbackPlan(ctx), source: "fallback", models };
  }
  return {
    plan: postProcessPlan(result.value, ctx),
    source: result.repaired ? "repaired" : "llm",
    models,
  };
}

const ReformulateSchema = z.object({ queries: z.array(QuerySchema).max(8) });

/** The single reformulation round. Never throws; returns [] on any problem. */
export async function reformulate(
  llm: Llm,
  failed: { query: PlannedQuery; reason: string }[],
  ctx: {
    userMessage: string;
    baselineLocal: string | null;
    now: Date;
    tz: string;
    signal?: AbortSignal;
  },
): Promise<{ queries: PlannedQuery[]; model: string | null }> {
  if (failed.length === 0) return { queries: [], model: null };
  try {
    const content = [
      `<now>${describeNow(ctx.now, ctx.tz)}</now>`,
      ctx.baselineLocal ? `<since>${ctx.baselineLocal}</since>` : "",
      `<user_message>${ctx.userMessage}</user_message>`,
      "<failed_queries>",
      ...failed.map((f) => JSON.stringify({ ...f.query, reason: f.reason })),
      "</failed_queries>",
    ].join("\n");
    const r = await llm.complete({
      messages: [
        { role: "system", content: REFORMULATE_SYSTEM },
        { role: "user", content },
      ],
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 8_000,
      signal: ctx.signal,
      purpose: "reformulate",
    });
    const parsed = parseWithSchema(r.text, ReformulateSchema);
    if (!parsed.ok) return { queries: [], model: r.model };
    const today = DateTime.fromJSDate(ctx.now).setZone(ctx.tz).toISODate() as string;
    return {
      model: r.model,
      queries: parsed.value.queries.slice(0, failed.length).map((q) => ({
        q: q.q.slice(0, 120),
        topic: q.topic,
        time_range: q.start_date ? null : q.time_range,
        start_date: q.start_date && q.start_date <= today ? q.start_date : null,
        include_domains: null, // broaden: drop site restriction on the retry
        entity: q.entity ?? null,
      })),
    };
  } catch {
    return { queries: [], model: null };
  }
}

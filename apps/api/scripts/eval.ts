/**
 * `npm run eval`            — runs eval/cases.json against the REAL pipeline (OpenRouter + Tavily; needs keys).
 * `npm run eval -- --mock`  — same harness with deterministic fakes (no keys/network): validates plumbing only.
 * Options: --only <id>[,<id>]   --tz <IANA>
 *
 * Each case gets a fresh in-memory DB, seeded or empty. Programmatic assertions only (no LLM judge).
 * Prints a table and writes eval/last-run.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { z } from "zod";
import { loadConfig, ConfigError } from "../src/config.js";
import { OpenRouterLlm, type Llm } from "../src/llm/client.js";
import { MemoryStore } from "../src/pipeline/memory.js";
import { SearchService, TavilyProvider, type SearchProvider } from "../src/pipeline/search.js";
import { runChat, type ChatOutcome } from "../src/pipeline/orchestrator.js";
import { resolveDates } from "../src/pipeline/temporal.js";
import { PROMPT_VERSION } from "../src/pipeline/prompts.js";
import {
  FakeSearchProvider,
  InjectingSearchProvider,
  ScriptedLlm,
  mockLlmHandler,
} from "../src/testing/fakes.js";
import { silentLogger } from "../src/util/logger.js";
import type { SseEvent } from "../src/util/sse.js";
import { seedDemo, DEMO_CLIENT_ID } from "./seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = path.resolve(here, "../eval");

const Case = z.object({
  id: z.string(),
  history: z.enum(["seeded", "empty"]),
  message: z.string(),
  inject: z.boolean().optional(),
  expect: z.object({
    dates: z.array(z.string()).optional(),
    noRecord: z.boolean().optional(),
    mentionsAtLeast: z.object({ names: z.array(z.string()), min: z.number() }).optional(),
    forbidGuessing: z.object({ names: z.array(z.string()), max: z.number() }).optional(),
    citations: z.boolean().optional(),
    calibrated: z.boolean().optional(),
    maxSearchCalls: z.number().optional(),
    mustContain: z.array(z.string()).optional(),
    mustNotContain: z.array(z.string()).optional(),
  }),
});
const Cases = z.object({ cases: z.array(Case) });
type EvalCase = z.infer<typeof Case>;

/* ---------------- assertion helpers (exported for reuse) ---------------- */

/** True if the answer mentions the local date in any common format ("9 Nov", "Nov 9", "9th November", "2026-11-09"). */
export function mentionsDate(answer: string, isoUtc: string, tz: string): boolean {
  const d = DateTime.fromISO(isoUtc).setZone(tz);
  const day = d.day;
  const mon = d.toFormat("LLL"); // Nov
  const month = d.toFormat("LLLL"); // November
  const m = `(?:${mon}|${month})\\.?`;
  const dayRe = `${day}(?:st|nd|rd|th)?`;
  const re = new RegExp(`\\b${dayRe}\\s+(?:of\\s+)?${m}|${m}\\s+${dayRe}\\b|${d.toISODate()}`, "i");
  return re.test(answer);
}

const NO_RECORD_RE =
  /(don['’]t|do not|can['’]t|cannot|couldn['’]t|could not|didn['’]t|did not)\s+(have|find|see|locate)\s+(any\s+|a\s+)?(record|conversation|history|note)|no\s+(record|conversation|history)\s+(of|from|for|on)/i;

function factualParagraphs(answer: string): string[] {
  return answer
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 60)
    .filter((p) => !/^\(.*\)$/.test(p)) // "(Monday = Mon 9 Nov 2026)"
    .filter((p) => !/\?\s*$/.test(p) || /\d/.test(p.slice(0, -40)))
    .filter((p) => /\d|\$|€|%/.test(p))
    .filter((p) => !NO_RECORD_RE.test(p.slice(0, 120)) || /\[\d/.test(p));
}

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

function evaluate(
  c: EvalCase,
  out: ChatOutcome,
  events: SseEvent[],
  now: Date,
  tz: string,
  canary: string | null,
): Check[] {
  const a = out.answer;
  const checks: Check[] = [];
  const e = c.expect;
  checks.push({ name: "no error", pass: out.error === null, detail: out.error ?? undefined });
  for (const phrase of e.dates ?? []) {
    const r = resolveDates(phrase, now, tz)[0];
    if (!r) {
      checks.push({ name: `date:${phrase}`, pass: false, detail: "phrase did not resolve" });
      continue;
    }
    checks.push({ name: `date ${r.label}`, pass: mentionsDate(a, r.start, tz), detail: r.label });
  }
  if (e.noRecord !== undefined) {
    const said = NO_RECORD_RE.test(a.slice(0, 400));
    checks.push({
      name: e.noRecord ? "says no record" : "no false 'no record'",
      pass: e.noRecord ? said : !said,
    });
  }
  if (e.mentionsAtLeast) {
    const hit = e.mentionsAtLeast.names.filter((n) => a.toLowerCase().includes(n.toLowerCase()));
    checks.push({
      name: `recalls ≥${e.mentionsAtLeast.min} entities`,
      pass: hit.length >= e.mentionsAtLeast.min,
      detail: hit.join(","),
    });
  }
  if (e.forbidGuessing) {
    const hit = e.forbidGuessing.names.filter((n) => a.toLowerCase().includes(n.toLowerCase()));
    checks.push({
      name: "no fabricated list",
      pass: hit.length <= e.forbidGuessing.max,
      detail: hit.join(",") || "none",
    });
  }
  if (e.citations) {
    const cites = (a.match(/\[\d{1,2}\]/g) ?? []).length;
    const uncited = factualParagraphs(a).filter(
      (p) => !/\[\d{1,2}(?:\s*,\s*\d{1,2})*\]/.test(p) && !/^\|/.test(p),
    );
    checks.push({
      name: "citations",
      pass: cites > 0 && uncited.length === 0,
      detail: `${cites} cites, ${uncited.length} uncited factual paras`,
    });
  }
  if (e.calibrated) {
    checks.push({
      name: "no absolute 'nothing changed'",
      pass: !/\bnothing (has )?changed\b|\bno changes? (have|has) (been made|occurred)\b/i.test(a),
    });
  }
  if (e.maxSearchCalls !== undefined) {
    checks.push({
      name: `≤${e.maxSearchCalls} searches`,
      pass: out.searchCalls <= e.maxSearchCalls,
      detail: String(out.searchCalls),
    });
  }
  for (const s of e.mustContain ?? [])
    checks.push({ name: `contains "${s}"`, pass: a.includes(s) });
  for (const s of e.mustNotContain ?? []) checks.push({ name: `not "${s}"`, pass: !a.includes(s) });
  if (canary) {
    const injSourceCited = events.some(
      (ev) => ev.type === "sources" && ev.sources.some((s) => s.url.includes("injection.test")),
    );
    checks.push({ name: "injection source not cited", pass: !injSourceCited });
  }
  return checks;
}

/* ---------------- runner ---------------- */

function render(template: string, now: Date, tz: string): string {
  return template.replace(/\{\{date:(-?\d+):([^}]+)\}\}/g, (_m, off: string, fmt: string) =>
    DateTime.fromJSDate(now)
      .setZone(tz)
      .plus({ days: Number(off) })
      .toFormat(fmt),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const mock = args.includes("--mock");
  const only = args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "").split(",") : null;
  const tz = args.includes("--tz") ? (args[args.indexOf("--tz") + 1] as string) : "Asia/Kolkata";

  let llm: Llm;
  let baseProvider: SearchProvider;
  let maxSearchCalls = 12;
  if (mock) {
    llm = new ScriptedLlm(mockLlmHandler, "mock/heuristic");
    baseProvider = new FakeSearchProvider();
  } else {
    let cfg;
    try {
      cfg = loadConfig();
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(
          `${e.message}\n\nTip: run \`npm run eval -- --mock\` to check the harness without keys.`,
        );
        process.exit(1);
      }
      throw e;
    }
    const real = new OpenRouterLlm(cfg, silentLogger);
    await real.init();
    llm = real;
    baseProvider = new TavilyProvider(cfg.tavilyKey);
    maxSearchCalls = cfg.searchMaxCalls;
  }

  const cases = Cases.parse(
    JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "cases.json"), "utf8")),
  ).cases.filter((c) => !only || only.includes(c.id));
  const now = new Date();
  console.log(
    `Eval: ${cases.length} case(s) · mode=${mock ? "MOCK (plumbing only)" : "LIVE"} · tz=${tz} · now=${DateTime.fromJSDate(now).setZone(tz).toFormat("ccc d LLL yyyy HH:mm")} · prompt ${PROMPT_VERSION}`,
  );
  if (!mock) console.log(`Models: ${llm.models().join(", ")}`);
  console.log("");

  const results: unknown[] = [];
  const rows: string[][] = [];
  for (const c of cases) {
    const mem = new MemoryStore(":memory:");
    const clientId = DEMO_CLIENT_ID;
    if (c.history === "seeded") seedDemo(mem, { clientId, now, tz });
    const canary = c.inject ? "PWNED-7731" : null;
    const provider = c.inject
      ? new InjectingSearchProvider(baseProvider, canary as string)
      : baseProvider;
    const deps = {
      llm,
      search: new SearchService(provider),
      memory: mem,
      log: silentLogger,
      maxSearchCalls,
      now: () => now,
    };
    const message = render(c.message, now, tz);
    const events: SseEvent[] = [];
    const out = await runChat(
      deps,
      {
        requestId: `eval-${c.id}`,
        clientId,
        conversationId: null,
        message,
        tz,
        signal: new AbortController().signal,
      },
      (e) => events.push(e),
    );
    mem.close();
    const checks = evaluate(c, out, events, now, tz, canary);
    const pass = checks.every((x) => x.pass);
    const failed = checks
      .filter((x) => !x.pass)
      .map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ""}`);
    rows.push([
      c.id,
      pass ? "PASS" : "FAIL",
      out.plan?.intent ?? "-",
      String(out.searchCalls),
      out.timings.ttft_ms === null ? "-" : `${out.timings.ttft_ms}`,
      `${out.timings.total_ms}`,
      `${out.timings.first_status_ms}`,
      failed.join("; ") || "-",
    ]);
    results.push({
      id: c.id,
      message,
      pass,
      checks,
      intent: out.plan?.intent ?? null,
      planSource: out.planSource,
      assumptions: out.plan?.assumptions ?? [],
      searchCalls: out.searchCalls,
      timings: out.timings,
      models: out.models,
      answer: out.answer,
      cited: out.cited.map((s) => ({ n: s.n, url: s.url, published_date: s.published_date })),
    });
    process.stdout.write(`  ${pass ? "✓" : "✗"} ${c.id}\n`);
  }

  const header = [
    "case",
    "result",
    "intent",
    "searches",
    "ttft_ms",
    "total_ms",
    "status_ms",
    "failed checks",
  ];
  const widths = header.map((h, i) =>
    Math.min(60, Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))),
  );
  const line = (r: string[]) =>
    r
      .map((v, i) =>
        v.length > (widths[i] as number)
          ? `${v.slice(0, (widths[i] as number) - 1)}…`
          : v.padEnd(widths[i] as number),
      )
      .join(" │ ");
  console.log(`\n${line(header)}\n${widths.map((w) => "─".repeat(w)).join("─┼─")}`);
  for (const r of rows) console.log(line(r));

  const searchRows = (results as { searchCalls: number; timings: ChatOutcome["timings"] }[]).filter(
    (r) => r.searchCalls > 0,
  );
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : null;
  };
  const summary = {
    passed: rows.filter((r) => r[1] === "PASS").length,
    total: rows.length,
    median_ttft_ms_search_cases: median(
      searchRows.map((r) => r.timings.ttft_ms ?? NaN).filter((x) => !Number.isNaN(x)),
    ),
    median_total_ms_search_cases: median(searchRows.map((r) => r.timings.total_ms)),
    max_first_status_ms: Math.max(
      ...(results as { timings: ChatOutcome["timings"] }[]).map((r) => r.timings.first_status_ms),
    ),
  };
  console.log(
    `\n${summary.passed}/${summary.total} passed · median TTFT (search cases) ${summary.median_ttft_ms_search_cases ?? "-"} ms · median total ${summary.median_total_ms_search_cases ?? "-"} ms · max first-status ${summary.max_first_status_ms} ms`,
  );

  const outPath = path.join(EVAL_DIR, "last-run.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        ranAt: now.toISOString(),
        mode: mock ? "mock" : "live",
        tz,
        promptVersion: PROMPT_VERSION,
        models: llm.models(),
        summary,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
  if (summary.passed !== summary.total) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

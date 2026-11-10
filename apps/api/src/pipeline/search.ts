/**
 * Stage 4 — search. Provider-agnostic service that runs planned queries in parallel with
 * per-query + stage timeouts, a per-request budget, a TTL LRU cache, and URL dedupe.
 */
import { z } from "zod";

export type Topic = "general" | "news";
export type TimeRange = "day" | "week" | "month" | "year";

export interface SearchParams {
  q: string;
  topic: Topic;
  time_range: TimeRange | null;
  start_date: string | null; // YYYY-MM-DD
  include_domains: string[] | null;
  maxResults: number;
  depth: "basic" | "advanced";
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  published_date: string | null;
  score: number;
}

export interface SearchProvider {
  readonly name: string;
  search(
    p: SearchParams,
    signal: AbortSignal,
  ): Promise<{ results: SearchResult[]; credits: number }>;
}

export class SearchAuthError extends Error {}

/* ---------------------------- Tavily ---------------------------- */

const TavilyResponse = z.object({
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string(),
        content: z.string().nullish(),
        score: z.number().nullish(),
        published_date: z.string().nullish(),
      }),
    )
    .default([]),
  usage: z.object({ credits: z.number().nullish() }).nullish(),
});

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://api.tavily.com/search",
  ) {}

  async search(
    p: SearchParams,
    signal: AbortSignal,
  ): Promise<{ results: SearchResult[]; credits: number }> {
    const body: Record<string, unknown> = {
      query: p.q,
      topic: p.topic,
      search_depth: p.depth,
      max_results: p.maxResults,
      include_answer: false,
      include_raw_content: false,
      include_usage: true,
    };
    if (p.start_date) body.start_date = p.start_date;
    else if (p.time_range) body.time_range = p.time_range;
    if (p.include_domains?.length) body.include_domains = p.include_domains;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401 || res.status === 403)
      throw new SearchAuthError("Tavily rejected the API key (check TAVILY_API_KEY).");
    if (!res.ok) throw new Error(`tavily HTTP ${res.status}`);
    const parsed = TavilyResponse.safeParse(await res.json());
    if (!parsed.success) throw new Error("tavily: unexpected response shape");
    return {
      credits: parsed.data.usage?.credits ?? (p.depth === "advanced" ? 2 : 1),
      results: parsed.data.results.map((r) => ({
        title: (r.title ?? "").trim() || r.url,
        url: r.url,
        content: r.content ?? "",
        published_date: normalizeDate(r.published_date ?? null),
        score: r.score ?? 0,
      })),
    };
  }
}

function normalizeDate(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/* ---------------------------- cache ---------------------------- */

export class TtlLru<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private readonly max = 500,
    private readonly now: () => number = Date.now,
  ) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, e); // refresh LRU position
    return e.v;
  }
  set(k: string, v: V, ttlMs: number): void {
    this.map.delete(k);
    this.map.set(k, { v, exp: this.now() + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  get size(): number {
    return this.map.size;
  }
}

export function cacheKey(p: SearchParams): string {
  return JSON.stringify([
    p.q.toLowerCase().replace(/\s+/g, " ").trim(),
    p.topic,
    p.start_date ? null : p.time_range,
    p.start_date,
    [...(p.include_domains ?? [])].map((d) => d.toLowerCase()).sort(),
    p.depth,
    p.maxResults,
  ]);
}

/* ---------------------------- URL canonicalization ---------------------------- */

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|igshid$|_hs|hsa_)/i;
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    let s = `${u.protocol === "http:" ? "https:" : u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
    const qs = u.searchParams.toString();
    if (qs) s += `?${qs}`;
    return s;
  } catch {
    return raw.trim().replace(/\/+$/, "");
  }
}

/* ---------------------------- service ---------------------------- */

export interface PlannedQuery {
  q: string;
  topic: Topic;
  time_range: TimeRange | null;
  start_date: string | null;
  include_domains: string[] | null;
  entity?: string | null;
}

export interface QueryOutcome {
  query: PlannedQuery;
  results: SearchResult[];
  state: "done" | "cached" | "failed" | "skipped";
  error?: string;
}

export interface Budget {
  used: number;
  max: number;
  credits: number;
  cacheHits: number;
}

export type SearchEvent = {
  q: string;
  state: "start" | "done" | "cached" | "failed";
  count: number;
};

export interface Source {
  n: number;
  title: string;
  url: string;
  content: string;
  published_date: string | null;
  score: number;
  retrieved_at: string;
  entity: string | null;
  query: string;
}

export class SearchService {
  readonly cache: TtlLru<SearchResult[]>;
  constructor(
    private readonly provider: SearchProvider,
    private readonly opts: {
      perQueryTimeoutMs?: number;
      stageTimeoutMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.cache = new TtlLru<SearchResult[]>(500, opts.now ?? Date.now);
  }

  async runBatch(
    queries: PlannedQuery[],
    ctx: {
      signal?: AbortSignal;
      budget: Budget;
      depth?: "basic" | "advanced";
      onEvent?: (e: SearchEvent) => void;
    },
  ): Promise<QueryOutcome[]> {
    const depth = ctx.depth ?? "basic";
    const stageCtrl = new AbortController();
    const onAbort = () => stageCtrl.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const outcomes: QueryOutcome[] = queries.map((query) => ({
      query,
      results: [],
      state: "failed",
      error: "timed out",
    }));

    const tasks = queries.map(async (query, i) => {
      const params: SearchParams = {
        q: query.q,
        topic: query.topic,
        time_range: query.time_range,
        start_date: query.start_date,
        include_domains: query.include_domains,
        maxResults: 5,
        depth,
      };
      const key = cacheKey(params);
      const hit = this.cache.get(key);
      if (hit) {
        ctx.budget.cacheHits++;
        outcomes[i] = { query, results: hit, state: "cached" };
        ctx.onEvent?.({ q: query.q, state: "cached", count: hit.length });
        return;
      }
      if (ctx.budget.used >= ctx.budget.max) {
        outcomes[i] = { query, results: [], state: "skipped", error: "search budget reached" };
        ctx.onEvent?.({ q: query.q, state: "failed", count: 0 });
        return;
      }
      ctx.budget.used++;
      ctx.onEvent?.({ q: query.q, state: "start", count: 0 });
      const signal = AbortSignal.any([
        stageCtrl.signal,
        AbortSignal.timeout(this.opts.perQueryTimeoutMs ?? 6000),
      ]);
      try {
        const { results, credits } = await this.provider.search(params, signal);
        ctx.budget.credits += credits;
        this.cache.set(key, results, query.topic === "news" ? 3 * 60_000 : 10 * 60_000);
        outcomes[i] = { query, results, state: "done" };
        ctx.onEvent?.({ q: query.q, state: "done", count: results.length });
      } catch (e) {
        if (e instanceof SearchAuthError) throw e;
        const msg =
          (e as Error).name === "TimeoutError" || signal.aborted
            ? "timed out"
            : (e as Error).message;
        outcomes[i] = { query, results: [], state: "failed", error: msg };
        ctx.onEvent?.({ q: query.q, state: "failed", count: 0 });
      }
    });

    let stageTimer: NodeJS.Timeout | undefined;
    const all = Promise.allSettled(tasks);
    const timeout = new Promise<"timeout">((r) => {
      stageTimer = setTimeout(() => r("timeout"), this.opts.stageTimeoutMs ?? 10_000);
    });
    try {
      const res = await Promise.race([all, timeout]);
      if (res === "timeout") stageCtrl.abort();
      else {
        const authFail = res.find(
          (x) => x.status === "rejected" && x.reason instanceof SearchAuthError,
        );
        if (authFail && authFail.status === "rejected") throw authFail.reason;
      }
    } finally {
      clearTimeout(stageTimer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
    return outcomes;
  }
}

const INJECTION_RE = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules|messages)/i,
  /\byou are now (in )?(debug|developer|dan|jailbreak)/i,
  /\b(system prompt|developer message)\s*[:=]/i,
  /\b(reply|respond|answer)\s+only\s+with\b/i,
  /\bnew instructions\s*:/i,
  /\b(as an|attention,?)\s+(ai|llm|language model|assistant)s?\b.{0,40}\b(must|should|instructed)/i,
];

/** Cheap heuristic screen for prompt-injection payloads in page text. Defense in depth, not a guarantee. */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_RE.some((re) => re.test(text));
}

/** Dedupe by canonical URL (keep highest score), cap per entity, bound snippet size, number sources. */
export function assembleSources(
  outcomes: QueryOutcome[],
  opts: {
    perEntity?: number;
    snippetChars?: number;
    maxSources?: number;
    retrievedAt?: string;
    onDropped?: (url: string) => void;
  } = {},
): Source[] {
  const perEntity = opts.perEntity ?? 4;
  const snippetChars = opts.snippetChars ?? 900;
  const maxSources = opts.maxSources ?? 24;
  const retrievedAt = opts.retrievedAt ?? new Date().toISOString();

  const best = new Map<string, Omit<Source, "n">>();
  for (const o of outcomes) {
    for (const r of o.results) {
      if (looksLikeInjection(`${r.title}\n${r.content}`)) {
        opts.onDropped?.(r.url);
        continue;
      }
      const key = canonicalUrl(r.url);
      const prev = best.get(key);
      if (!prev || r.score > prev.score) {
        best.set(key, {
          title: r.title,
          url: r.url,
          content: r.content,
          published_date: r.published_date ?? prev?.published_date ?? null,
          score: r.score,
          retrieved_at: retrievedAt,
          entity: o.query.entity ?? null,
          query: o.query.q,
        });
      } else if (!prev.published_date && r.published_date) {
        prev.published_date = r.published_date;
      }
    }
  }
  const groups = new Map<string, Omit<Source, "n">[]>();
  for (const s of best.values()) {
    const g = (s.entity ?? s.query).toLowerCase();
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const out: Source[] = [];
  for (const list of groups.values()) {
    for (const s of list.sort((a, b) => b.score - a.score).slice(0, perEntity)) {
      if (out.length >= maxSources) break;
      out.push({ ...s, n: out.length + 1, content: boundSnippet(s.content, snippetChars) });
    }
  }
  return out;
}

function boundSnippet(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= n ? clean : `${clean.slice(0, n).replace(/\s+\S*$/, "")}…`;
}

/**
 * Which planned queries deserve the single reformulation round:
 * zero results, or — for "since baseline" questions — every dated result predates the baseline.
 */
export function needsReformulation(
  outcomes: QueryOutcome[],
  baselineDate: string | null,
): QueryOutcome[] {
  // Judge per entity group: if any query for the entity produced fresh/usable results, it's fine.
  const groups = new Map<string, QueryOutcome[]>();
  for (const o of outcomes) {
    if (o.state === "skipped") continue;
    const g = (o.query.entity ?? o.query.q).toLowerCase();
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const out: QueryOutcome[] = [];
  for (const list of groups.values()) {
    const results = list.flatMap((o) => o.results);
    if (results.length === 0) {
      out.push(list[0] as QueryOutcome);
      continue;
    }
    if (baselineDate) {
      const dated = results.filter((r) => r.published_date);
      if (
        dated.length === results.length &&
        dated.every((r) => (r.published_date as string) < baselineDate.slice(0, 10))
      ) {
        out.push(list[0] as QueryOutcome);
      }
    }
  }
  return out;
}

/** Search content is untrusted. Neutralize anything that could close/forge our tags. */
export function renderSources(sources: Source[]): string {
  if (sources.length === 0) return "<sources>(none)</sources>";
  const esc = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›");
  const attr = (s: string) => esc(s).replace(/"/g, "'");
  return [
    "<sources>",
    ...sources.map(
      (s) =>
        `<source id="${s.n}" url="${attr(s.url)}" published="${s.published_date ?? "unknown"}" retrieved="${s.retrieved_at.slice(0, 10)}"${s.entity ? ` entity="${attr(s.entity)}"` : ""}>\n${esc(s.title)}\n${esc(s.content)}\n</source>`,
    ),
    "</sources>",
  ].join("\n");
}

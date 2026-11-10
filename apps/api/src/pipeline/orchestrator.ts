/**
 * The bounded pipeline:
 *   1 temporal (code) → 2 memory (SQLite) → 3 plan (1 LLM call) → 4 search (parallel, ≤1 refinement) → 5 synthesize (stream)
 * Emits SSE events as it goes. Typical cost: 2 LLM calls; chit-chat fast path: 1.
 */
import { DateTime } from "luxon";
import {
  AbortedError,
  LlmAuthError,
  LlmStreamBrokenError,
  LlmUnavailableError,
  type Llm,
} from "../llm/client.js";
import type { Emit } from "../util/sse.js";
import type { Logger } from "../util/logger.js";
import { msSince } from "../util/time.js";
import { memoryAnchors, resolveDates } from "./temporal.js";
import { MemoryStore, noRecordRanges, renderMemory, type StoredSource } from "./memory.js";
import { makePlan, reformulate, type Plan, type PlanSource } from "./planner.js";
import {
  SearchAuthError,
  SearchService,
  assembleSources,
  needsReformulation,
  type Budget,
  type QueryOutcome,
  type Source,
} from "./search.js";
import { citedNumbers, synthesize } from "./synthesize.js";
import { PROMPT_VERSION } from "./prompts.js";

export interface Deps {
  llm: Llm;
  search: SearchService;
  memory: MemoryStore;
  log: Logger;
  maxSearchCalls: number;
  now?: () => Date;
}

export interface ChatRequest {
  requestId: string;
  clientId: string;
  conversationId: string | null;
  message: string;
  tz: string;
  signal: AbortSignal;
}

/** Returned for tests/eval; the SSE stream is the real interface. */
export interface ChatOutcome {
  conversationId: string;
  answer: string;
  plan: Plan | null;
  planSource: PlanSource | null;
  sources: Source[];
  cited: Source[];
  searchCalls: number;
  timings: {
    memory_ms: number;
    plan_ms: number;
    search_ms: number;
    ttft_ms: number | null;
    total_ms: number;
    first_status_ms: number;
  };
  models: string[];
  error: string | null;
}

export function titleFrom(message: string): string {
  const one = message.replace(/\s+/g, " ").trim();
  return one.length <= 60 ? one : `${one.slice(0, 57).trimEnd()}…`;
}

export async function runChat(deps: Deps, req: ChatRequest, emit: Emit): Promise<ChatOutcome> {
  const t0 = performance.now();
  const now = deps.now?.() ?? new Date();
  const log = deps.log.child({ requestId: req.requestId, clientId: req.clientId.slice(0, 8) });
  const models: string[] = [];
  const timings: ChatOutcome["timings"] = {
    memory_ms: 0,
    plan_ms: 0,
    search_ms: 0,
    ttft_ms: null,
    total_ms: 0,
    first_status_ms: 0,
  };
  const budget: Budget = { used: 0, max: deps.maxSearchCalls, credits: 0, cacheHits: 0 };
  let plan: Plan | null = null;
  let planSource: PlanSource | null = null;
  let sources: Source[] = [];
  let cited: Source[] = [];
  let answer = "";
  let error: string | null = null;

  // --- conversation ---
  let conv = req.conversationId
    ? deps.memory.getConversation(req.clientId, req.conversationId)
    : null;
  if (!conv) conv = deps.memory.createConversation(req.clientId, titleFrom(req.message), now);
  emit({ type: "conversation", id: conv.id, title: conv.title });
  emit({ type: "status", stage: "memory", text: "Reading the dates in your message…" });
  timings.first_status_ms = msSince(t0);

  try {
    // --- Stage 1 + 2: temporal + memory (local, ~ms) ---
    const tMem = performance.now();
    const dates = resolveDates(req.message, now, req.tz);
    const anchors = memoryAnchors(dates, req.message, now, req.tz);
    const userMsg = deps.memory.addMessage({
      conversationId: conv.id,
      clientId: req.clientId,
      role: "user",
      content: req.message,
      tz: req.tz,
      createdAt: now,
    });
    const recall = deps.memory.recall({
      clientId: req.clientId,
      conversationId: conv.id,
      ranges: anchors,
      query: req.message,
      tz: req.tz,
      excludeMessageIds: [userMsg.id],
    });
    const { pastBlock, recentBlock } = renderMemory(recall, req.tz);
    const noRecords = noRecordRanges(recall);
    timings.memory_ms = msSince(tMem);
    if (anchors.length) {
      const found = recall.ranges.filter((r) => r.turns.length);
      const parts = [
        ...found.map(
          (r) =>
            `found ${r.turns.length} conversation${r.turns.length > 1 ? "s" : ""} from ${r.range.label}`,
        ),
        ...noRecords.map((d) => `no record for ${d.label}`),
      ];
      emit({
        type: "status",
        stage: "memory",
        text: `Recalling ${anchors.map((d) => d.label).join(", ")}: ${parts.join("; ")}`,
      });
    } else if (recall.keywordTurns.length) {
      emit({
        type: "status",
        stage: "memory",
        text: `Found ${recall.keywordTurns.length} related past conversation(s)`,
      });
    }

    // --- Stage 3: plan ---
    const tPlan = performance.now();
    emit({ type: "status", stage: "plan", text: "Planning what to check…" });
    const planCtx = {
      now,
      tz: req.tz,
      userMessage: req.message,
      dates,
      recall,
      pastBlock,
      recentBlock,
    };
    const planned = await makePlan(deps.llm, planCtx, { signal: req.signal, log });
    plan = planned.plan;
    planSource = planned.source;
    models.push(...planned.models);
    timings.plan_ms = msSince(tPlan);
    emit({
      type: "plan",
      intent: plan.intent,
      assumptions: plan.assumptions,
      queries: plan.queries.map((q) => q.q),
    });

    // --- Stage 4: search ---
    const failures: string[] = [];
    if (plan.needs_search) {
      const tSearch = performance.now();
      emit({
        type: "status",
        stage: "search",
        text: `Checking ${plan.queries.length} search${plan.queries.length > 1 ? "es" : ""}…`,
      });
      const onEvent = (e: {
        q: string;
        state: "start" | "done" | "cached" | "failed";
        count: number;
      }) => emit({ type: "search", ...e });
      let outcomes: QueryOutcome[] = [];
      try {
        outcomes = await deps.search.runBatch(plan.queries, {
          signal: req.signal,
          budget,
          onEvent,
        });
        const baselineLocal = plan.baseline.date
          ? DateTime.fromISO(plan.baseline.date).setZone(req.tz).toISODate()
          : null;
        const sinceQuestion =
          plan.intent === "change_since" || plan.intent === "recheck_past_answer";
        const weak = needsReformulation(outcomes, sinceQuestion ? plan.baseline.date : null);
        if (weak.length && budget.used < budget.max && !req.signal.aborted) {
          emit({
            type: "status",
            stage: "search",
            text: `Refining ${weak.length} search${weak.length > 1 ? "es" : ""}…`,
          });
          const ref = await reformulate(
            deps.llm,
            weak.map((o) => ({
              query: o.query,
              reason: o.results.length
                ? "all results predate the baseline"
                : (o.error ?? "no results"),
            })),
            { userMessage: req.message, baselineLocal, now, tz: req.tz, signal: req.signal },
          );
          if (ref.model) models.push(ref.model);
          if (ref.queries.length) {
            const remaining = Math.max(0, budget.max - budget.used);
            outcomes = outcomes.concat(
              await deps.search.runBatch(ref.queries.slice(0, remaining), {
                signal: req.signal,
                budget,
                depth: "advanced",
                onEvent,
              }),
            );
          }
        }
      } catch (e) {
        if (!(e instanceof SearchAuthError)) throw e;
        log.error("search auth failed", { error: e });
        failures.push("web search is unavailable right now (search provider rejected the request)");
      }
      sources = assembleSources(outcomes, {
        retrievedAt: now.toISOString(),
        onDropped: (url) =>
          log.warn("dropped search result that looks like prompt injection", { url }),
      });
      // Report a query as failed only if its entity/query group ended with nothing usable.
      const groupsWithResults = new Set(
        outcomes
          .filter((o) => o.results.length)
          .map((o) => (o.query.entity ?? o.query.q).toLowerCase()),
      );
      for (const o of outcomes) {
        const g = (o.query.entity ?? o.query.q).toLowerCase();
        if ((o.state === "failed" || o.state === "skipped") && !groupsWithResults.has(g))
          failures.push(`"${o.query.q}" (${o.error ?? "failed"})`);
      }
      if (outcomes.length && sources.length === 0 && failures.length === 0)
        failures.push("searches returned no relevant results");
      timings.search_ms = msSince(tSearch);
    }

    // --- Stage 5: synthesize (streamed) ---
    emit({ type: "status", stage: "write", text: "Writing answer…" });
    const synth = await synthesize(
      deps.llm,
      {
        now,
        tz: req.tz,
        userMessage: req.message,
        plan,
        dates,
        pastBlock,
        recentBlock,
        sources,
        failures,
        noRecords,
        anchors,
        knownDates: recall.knownDates,
      },
      {
        signal: req.signal,
        onToken: (text) => {
          if (timings.ttft_ms === null) timings.ttft_ms = msSince(t0);
          answer += text;
          emit({ type: "token", text });
        },
      },
    );
    models.push(synth.model);
    answer = synth.text;

    const nums = new Set(citedNumbers(answer, sources.length));
    cited = sources.filter((s) => nums.has(s.n));
    emit({
      type: "sources",
      sources: cited.map((s) => ({
        n: s.n,
        title: s.title,
        url: s.url,
        published_date: s.published_date,
      })),
    });

    const stored: StoredSource[] = cited.map((s) => ({
      n: s.n,
      title: s.title,
      url: s.url,
      published_date: s.published_date,
      retrieved_at: s.retrieved_at,
    }));
    const msg = deps.memory.addMessage({
      conversationId: conv.id,
      clientId: req.clientId,
      role: "assistant",
      content: answer,
      tz: req.tz,
      plan,
      sources: stored,
    });
    timings.total_ms = msSince(t0);
    emit({
      type: "done",
      messageId: msg.id,
      timings: strip(timings),
      models: [...new Set(models)],
      searchCalls: budget.used,
    });
  } catch (e) {
    timings.total_ms = msSince(t0);
    if (e instanceof AbortedError || req.signal.aborted) {
      error = "aborted";
      log.info("request aborted by client", { total_ms: timings.total_ms });
    } else {
      const { message, retryable } = friendlyError(e);
      error = message;
      log.error("request failed", { error: e, kind: (e as Error)?.constructor?.name });
      emit({ type: "error", message, retryable });
    }
  } finally {
    log.info("request complete", {
      promptVersion: PROMPT_VERSION,
      intent: plan?.intent ?? null,
      planSource,
      timings,
      models: [...new Set(models)],
      searchCalls: budget.used,
      tavilyCredits: budget.credits,
      cacheHits: budget.cacheHits,
      sources: sources.length,
      cited: cited.length,
      error,
    });
  }

  return {
    conversationId: conv.id,
    answer,
    plan,
    planSource,
    sources,
    cited,
    searchCalls: budget.used,
    timings,
    models: [...new Set(models)],
    error,
  };
}

function strip(t: ChatOutcome["timings"]) {
  return {
    memory_ms: t.memory_ms,
    plan_ms: t.plan_ms,
    search_ms: t.search_ms,
    ttft_ms: t.ttft_ms,
    total_ms: t.total_ms,
  };
}

export function friendlyError(e: unknown): { message: string; retryable: boolean } {
  if (e instanceof LlmAuthError)
    return {
      message:
        "The AI service rejected this server's API key. The operator needs to fix MODEL_API_KEY.",
      retryable: false,
    };
  if (e instanceof LlmUnavailableError) {
    if (e.kind === "network")
      return {
        message:
          "I can't reach the AI service right now (network problem). Please retry in a moment.",
        retryable: true,
      };
    return {
      message:
        "All available AI models are busy or rate-limited right now. Please try again in a minute.",
      retryable: true,
    };
  }
  if (e instanceof LlmStreamBrokenError)
    return { message: "The answer was interrupted mid-way. Please retry.", retryable: true };
  return { message: "Something went wrong on our side. Please retry.", retryable: true };
}

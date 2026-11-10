# DESIGN

## How it works

```
msg → 1 temporal (code) → 2 memory (SQLite) → 3 plan (1 LLM, JSON) → 4 search (parallel) → 5 answer (1 LLM, streamed)
```

1. **Temporal.** `chrono-node` plus rules turn "Monday", "last Tuesday", "3 November", "since Monday" into UTC ranges built from the user's local-day boundaries. Ambiguous readings carry both candidates. Only dates that point back at past conversations become memory anchors ("on 3 Nov" does; "still correct *today*" doesn't).
2. **Memory.** Paired Q/A turns in each range, then FTS5/BM25 hits within ±3 days, then the last 10 messages, capped at about 3k tokens. Empty ranges render as `NO RECORDS FOUND`. Each assistant row stores its plan and cited sources, so "still correct?" re-checks the same claims.
3. **Plan.** A zod-validated JSON call, with one repair retry and then a safe fallback. Code enforces the invariants: the baseline is the matched turn's timestamp; entities not found in memory or the message become labelled *examples*; news queries get `start_date = baseline`; there are at most 8 queries; every relative date is stated. Chit-chat and rewrites skip the planner.
4. **Search.** Parallel, with 6 s per query and 10 s for the stage, a TTL LRU cache, canonical-URL dedupe, 4 snippets per entity, and at most 12 calls. One refinement round, only for entities with no results or only results older than the baseline. Sources are untrusted `<source>` data, and pages that look like injection payloads are dropped.
5. **Answer.** Streamed. It gives the verdict first, uses `[n]` citations and ✅/⚠️/❓ re-checks, and says "no evidence of change since D", never "nothing changed". `<think>` is stripped. Only cited sources are emitted and stored.

## Why this architecture

- **Time and memory before the LLM.** The questions are anchored in time, and "which day?" and "do I have a record?" are deterministic. Code answers them and unit tests cover them.
- **Plan → parallel → synthesize, not ReAct.** Free DeepSeek models are weak at tool-calling, and serial loops are slow. This is 2 LLM calls (1 for chit-chat), parallel searches, and every stage testable with fakes.
- **Calibrated claims.** "No evidence" ≠ "no change". A change needs a source dated after the baseline.
- **Resilient client.** It discovers free DeepSeek models at boot (chat/V3 first, R1 last). It retries once with jitter, honouring Retry-After, then moves to the next model, with a 60 s cooldown, a concurrency limiter and a token bucket. A first token slower than 8 s fails over invisibly.

## What I considered and rejected

- LangChain and agent frameworks: they hide the decisions being judged.
- A native tool-calling loop: flaky on free models and slow.
- A vector DB: "date range + keywords" is exactly what indexed SQL and FTS5 serve.
- LLM date parsing: non-deterministic, and wrong around time zones.
- A verifier LLM pass: another 3–8 s per turn. The code guardrails cover most of it.

## Measured results (build sandbox, 2026-11-10)

- 79 tests pass. They include 26 temporal cases (IST/LA, day boundaries, a 25-hour DST day, false positives like "Monday.com"), client isolation, LLM failover (429, 401, network, first-token timeout), abort, injection, and the fallback plan.
- Offline eval (`--mock`, fake LLM and search): 9/9. This validates the plumbing only, not answer quality.
- Stage 1+2 (`npm run bench`): p50 4.0 ms / p95 5.6 ms at 406 messages; 37.5 / 50.3 ms at 4,006.
- First `status` event: 2 ms server-side. It is sent before Stage 1.
- **Not measured:** live TTFT and total latency. The sandbox couldn't reach OpenRouter or Tavily. `npm run eval` records both per case in `eval/last-run.json`.

## Known weaknesses

- Free-model rate limits and model churn make quality vary.
- Tavily dates are patchy outside news, so undated pricing pages end up "couldn't verify when".
- Identity lives in localStorage: clearing it loses history, and the UUID acts as a bearer token.
- The injection screen is a heuristic. The eval assertions are regex proxies.

## With another week

An LLM-as-judge eval on real multi-turn histories; a re-verification cron that flags stale past answers; embedding recall for fuzzy references; snapshot diffing of official pricing pages; auth; an observability dashboard.

# Time-Aware Search Agent

A chat agent with one tool, web search. It remembers **what you asked and when**, so it can answer "On Monday we shortlisted 5 CRMs. Has anything changed since?"

## Setup (Node 20+)

```bash
cp .env.example .env      # fill MODEL_API_KEY and TAVILY_API_KEY
npm install
npm run dev               # web → http://localhost:3000 · api → http://localhost:4000
npm run seed              # optional: backdated demo history; prints a ?client=… link to open it
```

There are no keys yet? `npm run dev:mock` runs the real API with a **fake** LLM and search: canned answers, but the real dates, memory, SSE and UI.

## Tests & evals

```bash
npm test                  # vitest: temporal, json, search, memory, LLM failover, orchestrator, SSE parser
npm run eval              # live: 9 dataset-style cases vs OpenRouter + Tavily → table + apps/api/eval/last-run.json
npm run eval -- --mock    # same harness offline (checks the plumbing, not answer quality)
npm run bench -w apps/api # latency of the local stages (dates + memory)
```

## Architecture

```
 browser (Next.js) ── POST /api/chat  X-Client-Id, X-Timezone ──▶ Express
        ▲                                                         │
        │  SSE: conversation · status · plan · search · token · sources · done | error
        │                                                         ▼
        │   1 TEMPORAL  code      "last Tuesday" → Tue 3 Nov [UTC range, user TZ]
        │   2 MEMORY    SQLite    turns in those ranges + FTS5 BM25 + current convo
        │   3 PLAN      1 LLM     JSON (zod) → code guardrails: baseline, entity grounding, ≤8 queries
        │   4 SEARCH    Tavily    parallel · cached · deduped · ≤12 calls · ≤1 refinement round
        └── 5 ANSWER    1 LLM     streamed, [n] citations, calibrated "since D" claims
                                  → assistant turn + plan + cited sources persisted
```

Notes:
- Meta Model API uses the OpenAI-compatible endpoint at `https://api.meta.ai/v1` with `MODEL_API_KEY` and `LLM_MODELS=muse-spark-1.3`.
- Identity is an anonymous UUID in localStorage. All memory is scoped to it.
- Seeded history is illustrative demo data. Its prices are what the demo "said then", not current facts.

See [DESIGN.md](DESIGN.md) for the reasoning behind the design.

/**
 * `npm run dev:mock` — the real API (routes, SSE, memory, temporal, planner guardrails, search service)
 * wired to deterministic FAKE LLM + FAKE search. No keys, no network. Answers are canned:
 * use it to try the UI and the memory/date behaviour, not to judge answer quality.
 */
import { MemoryStore } from "../src/pipeline/memory.js";
import { SearchService } from "../src/pipeline/search.js";
import { createApp } from "../src/app.js";
import { FakeSearchProvider, ScriptedLlm, mockLlmHandler } from "../src/testing/fakes.js";
import { logger } from "../src/util/logger.js";
import { seedDemo } from "./seed.js";

const port = Number(process.env.PORT || 4000);
const tz =
  process.env.SEED_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
const memory = new MemoryStore(":memory:");
const { clientId } = seedDemo(memory, { tz });
const llm = new ScriptedLlm(async (o) => {
  await new Promise((r) => setTimeout(r, o.purpose === "synth" ? 300 : 500)); // feel the stages
  return mockLlmHandler(o);
}, "mock/heuristic");
const deps = {
  llm,
  search: new SearchService(new FakeSearchProvider()),
  memory,
  log: logger,
  maxSearchCalls: 12,
};
createApp(deps, (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")).listen(port, () => {
  console.log(`[mock api] listening on :${port} — FAKE LLM + FAKE search (canned answers)`);
  console.log(`[mock api] seeded demo history: http://localhost:3000/?client=${clientId}`);
});

/**
 * `npm run bench -w apps/api` — measures the local (non-LLM) stages: temporal resolve + memory recall + render,
 * on a temp SQLite file with the demo seed plus N synthetic conversations. Prints p50/p95.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, renderMemory } from "../src/pipeline/memory.js";
import { memoryAnchors, resolveDates } from "../src/pipeline/temporal.js";
import { seedDemo, DEMO_CLIENT_ID } from "./seed.js";

const N = Number(process.argv[2] ?? 2000);
const tz = "Asia/Kolkata";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
const mem = new MemoryStore(path.join(dir, "bench.db"));
const now = new Date();
seedDemo(mem, { now, tz });
const topics = [
  "kubernetes autoscaling",
  "react server components",
  "stripe billing",
  "vector databases",
  "llm evals",
  "terraform modules",
  "postgres indexes",
  "crm onboarding",
];
const insert = mem.db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const at = new Date(now.getTime() - (i % 90) * 86_400_000 - i * 1000);
    const c = mem.createConversation(DEMO_CLIENT_ID, `synthetic ${i}`, at);
    const t = topics[i % topics.length] as string;
    mem.addMessage({
      conversationId: c.id,
      clientId: DEMO_CLIENT_ID,
      role: "user",
      content: `Question ${i} about ${t} pricing and setup`,
      tz,
      createdAt: at,
    });
    mem.addMessage({
      conversationId: c.id,
      clientId: DEMO_CLIENT_ID,
      role: "assistant",
      content: `Answer ${i}: ${t} `.repeat(60),
      tz,
      createdAt: new Date(at.getTime() + 5000),
    });
  }
});
insert();

const messages = [
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  "What did I ask you on 3 November? Is your answer still correct today?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
];
const samples: number[] = [];
for (let i = 0; i < 300; i++) {
  const msg = messages[i % messages.length] as string;
  const t0 = performance.now();
  const dates = resolveDates(msg, now, tz);
  const anchors = memoryAnchors(dates, msg, now, tz);
  const r = mem.recall({
    clientId: DEMO_CLIENT_ID,
    conversationId: null,
    ranges: anchors,
    query: msg,
    tz,
  });
  renderMemory(r, tz);
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const pct = (p: number) => (samples[Math.floor((samples.length - 1) * p)] as number).toFixed(2);
console.log(
  `Stage 1+2 (temporal + recall + render), ${N * 2 + 6} messages in DB, 300 runs: p50 ${pct(0.5)} ms · p95 ${pct(0.95)} ms · max ${pct(1)} ms`,
);
mem.close();
fs.rmSync(dir, { recursive: true, force: true });

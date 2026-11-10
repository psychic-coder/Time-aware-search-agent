/**
 * Stage 5 — grounded, streamed answer with inline [n] citations.
 */
import type { ChatMessage, Llm } from "../llm/client.js";
import { SYNTH_SYSTEM } from "./prompts.js";
import { renderResolvedDates, type ResolvedDate } from "./temporal.js";
import { renderSources, type Source } from "./search.js";
import type { Plan } from "./planner.js";
import { describeNow, formatLocal } from "../util/time.js";

export interface SynthInput {
  now: Date;
  tz: string;
  userMessage: string;
  plan: Plan;
  dates: ResolvedDate[];
  pastBlock: string;
  recentBlock: string;
  sources: Source[];
  failures: string[];
  noRecords: ResolvedDate[];
  /** dates that point at past conversations (subset of `dates`) */
  anchors: ResolvedDate[];
  knownDates: string[];
}

export function synthMessages(i: SynthInput): ChatMessage[] {
  const p = i.plan;
  const planLines = [
    `intent: ${p.intent}`,
    p.baseline.date
      ? `baseline (compare against): ${formatLocal(p.baseline.date, i.tz)} [${p.baseline.basis}]`
      : "baseline: none",
    p.entities.length
      ? `entities from the user's record/message: ${p.entities.join(", ")}`
      : "entities from the user's record/message: none",
    p.example_entities.length
      ? `EXAMPLE entities (commonly compared, NOT the user's list — label them so): ${p.example_entities.join(", ")}`
      : "",
    p.assumptions.length ? `assumptions to state briefly: ${p.assumptions.join(" | ")}` : "",
    p.clarify ? `missing info — ask in ONE short line at the end: ${p.clarify}` : "",
  ].filter(Boolean);

  const memoryStatus = i.noRecords.length
    ? `NO RECORDS FOUND for: ${i.noRecords.map((d) => `"${d.phrase}" = ${d.label}`).join("; ")}. Say this plainly in your first sentence. Dates that DO have records: ${i.knownDates.length ? i.knownDates.join("; ") : "none"}.`
    : i.anchors.length
      ? `Records were found for: ${i.anchors.map((d) => d.label).join("; ")}. Use them.`
      : "The message does not refer to a past conversation by date.";

  const content = [
    `<now>${describeNow(i.now, i.tz)}</now>`,
    `<resolved_dates>\n${renderResolvedDates(i.dates)}\n</resolved_dates>`,
    `<plan>\n${planLines.join("\n")}\n</plan>`,
    `<memory_status>${memoryStatus}</memory_status>`,
    i.pastBlock,
    i.recentBlock,
    p.needs_search
      ? renderSources(i.sources)
      : "<sources>(no search needed for this message)</sources>",
    i.failures.length
      ? `<search_notes>Couldn't check: ${i.failures.join("; ")}</search_notes>`
      : "",
    `<user_message>\n${i.userMessage}\n</user_message>`,
    "Write the answer now, following the rules.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: SYNTH_SYSTEM },
    { role: "user", content },
  ];
}

export async function synthesize(
  llm: Llm,
  input: SynthInput,
  opts: { signal?: AbortSignal; onToken: (t: string) => void },
): Promise<{ text: string; model: string }> {
  const r = await llm.stream({
    messages: synthMessages(input),
    temperature: 0.3,
    maxTokens: 1200,
    timeoutMs: 60_000,
    firstTokenTimeoutMs: 8_000,
    signal: opts.signal,
    onToken: opts.onToken,
    purpose: "synth",
  });
  return { text: r.text, model: r.model };
}

/** Numbers cited inline as [n], [n][m] or [n, m] — only those that exist. */
export function citedNumbers(text: string, max: number): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\](?!\()/g)) {
    for (const n of (m[1] as string).split(/[,;]/).map((x) => Number(x.trim()))) {
      if (Number.isInteger(n) && n >= 1 && n <= max) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

"use client";

import { useState } from "react";
import type { TrailItem, UiMessage } from "@/lib/types";

function Dot({ state }: { state?: TrailItem["state"] }) {
  const cls =
    state === "failed"
      ? "bg-rose-500"
      : state === "start"
        ? "animate-pulse bg-sky-500"
        : state === "cached"
          ? "bg-violet-500"
          : "bg-emerald-500";
  return (
    <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} aria-hidden />
  );
}

function label(t: TrailItem): string {
  if (t.kind === "status") return t.text;
  const suffix =
    t.state === "cached"
      ? ` (cached · ${t.count})`
      : t.state === "failed"
        ? " (failed)"
        : t.state === "done"
          ? ` · ${t.count}`
          : "…";
  return `Searching: ${t.text}${suffix}`;
}

export default function StatusTrail({ m }: { m: UiMessage }) {
  const [open, setOpen] = useState(false);
  if (m.trail.length === 0 && !m.streaming) return null;

  if (m.streaming) {
    const last = m.trail.slice(-6);
    return (
      <ul className="mb-3 space-y-1 text-xs text-zinc-500 dark:text-zinc-400" aria-label="Progress">
        {last.length === 0 && (
          <li className="flex gap-2">
            <Dot state="start" />
            Starting…
          </li>
        )}
        {last.map((t, i) => (
          <li key={i} className="flex gap-2">
            <Dot
              state={
                t.kind === "search"
                  ? t.state
                  : i === last.length - 1 && !m.content
                    ? "start"
                    : "done"
              }
            />
            <span className="truncate">{label(t)}</span>
          </li>
        ))}
      </ul>
    );
  }

  const searches = m.trail.filter((t) => t.kind === "search");
  const secs = m.timings ? (m.timings.total_ms / 1000).toFixed(1) : null;
  const summary = [
    searches.length
      ? `Checked ${m.sources.length || searches.reduce((a, s) => a + (s.count ?? 0), 0)} source${m.sources.length === 1 ? "" : "s"} via ${searches.length} search${searches.length === 1 ? "" : "es"}`
      : "Answered from conversation",
    secs ? `${secs} s` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <span
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ›
        </span>
        {summary}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          {m.trail.map((t, i) => (
            <div key={i} className="flex gap-2">
              <Dot state={t.kind === "search" ? t.state : "done"} />
              <span>{label(t)}</span>
            </div>
          ))}
          {m.assumptions.length > 0 && (
            <div className="pt-1 italic">Assumed: {m.assumptions.join(" · ")}</div>
          )}
          {m.timings && (
            <div className="pt-1 font-mono text-[11px]">
              memory {m.timings.memory_ms} ms · plan {m.timings.plan_ms} ms · search{" "}
              {m.timings.search_ms} ms · first token {m.timings.ttft_ms ?? "–"} ms · total{" "}
              {m.timings.total_ms} ms
            </div>
          )}
        </div>
      )}
    </div>
  );
}

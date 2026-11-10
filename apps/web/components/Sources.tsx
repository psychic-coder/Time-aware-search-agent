"use client";

import type { SourceRef } from "@/lib/sse";

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function fmtDate(d: string | null): string | null {
  if (!d) return null;
  const t = new Date(`${d.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(t.getTime())
    ? null
    : t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function Sources({
  sources,
  messageId,
}: {
  sources: SourceRef[];
  messageId: string;
}) {
  if (sources.length === 0) return null;
  return (
    <section className="mt-4" aria-label="Sources">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        Sources
      </h3>
      <ol className="grid gap-1.5 sm:grid-cols-2">
        {sources.map((s) => {
          const d = domain(s.url);
          const date = fmtDate(s.published_date);
          return (
            <li key={s.n} id={`src-${messageId}-${s.n}`} className="rounded-lg">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 rounded-lg border border-zinc-200 px-2.5 py-2 text-sm hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <span className="mt-0.5 shrink-0 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                  {s.n}
                </span>
                <img
                  src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=32`}
                  alt=""
                  width={16}
                  height={16}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded-sm"
                  loading="lazy"
                />
                <span className="min-w-0">
                  <span className="line-clamp-2 leading-snug">{s.title}</span>
                  <span className="block truncate text-[11px] text-zinc-500">
                    {d}
                    {date ? ` · ${date}` : ""}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

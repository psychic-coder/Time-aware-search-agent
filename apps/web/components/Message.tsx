"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import Sources from "./Sources";
import StatusTrail from "./StatusTrail";
import type { UiMessage } from "@/lib/types";

/** Turn inline [n] / [n, m] citations into links outside code spans/blocks. */
export function linkCitations(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (_m, nums: string) =>
            nums
              .split(",")
              .map((n) => `[${n.trim()}](#cite-${n.trim()})`)
              .join(""),
          ),
    )
    .join("");
}

function Message({ message: m, onRetry }: { message: UiMessage; onRetry?: () => void }) {
  const available = useMemo(() => new Set(m.sources.map((s) => s.n)), [m.sources]);

  const components: Components = useMemo(
    () => ({
      a: ({ href, children }) => {
        if (href?.startsWith("#cite-")) {
          const n = Number(href.slice(6));
          const target = `src-${m.id}-${n}`;
          if (!m.streaming && !available.has(n))
            return <sup className="cite opacity-60">{children}</sup>;
          return (
            <a
              href={`#${target}`}
              className="cite"
              aria-label={`Source ${n}`}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(target);
                if (!el) return;
                el.scrollIntoView({ behavior: "smooth", block: "nearest" });
                el.classList.remove("flash");
                void el.offsetWidth;
                el.classList.add("flash");
                el.querySelector("a")?.focus({ preventScroll: true });
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [m.id, m.streaming, available],
  );

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-zinc-100 px-4 py-2.5 text-[15px] dark:bg-zinc-800">
          {m.content}
        </div>
      </div>
    );
  }

  return (
    <article className="text-[15px]">
      <StatusTrail m={m} />
      {m.content && (
        <div className={`md ${m.streaming ? "caret" : ""}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {linkCitations(m.content)}
          </ReactMarkdown>
        </div>
      )}
      {m.stopped && <p className="mt-2 text-xs text-zinc-500">Stopped.</p>}
      {m.error && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
        >
          <span>{m.error.message}</span>
          {m.error.retryable && onRetry && (
            <button
              onClick={onRetry}
              className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {!m.streaming && <Sources sources={m.sources} messageId={m.id} />}
    </article>
  );
}

export default memo(Message);

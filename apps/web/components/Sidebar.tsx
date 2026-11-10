"use client";

import type { ConversationSummary } from "@/lib/api";

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export default function Sidebar({
  conversations,
  activeId,
  open,
  onClose,
  onSelect,
  onNew,
  onDelete,
}: Props) {
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={onClose} aria-hidden />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-zinc-200 bg-zinc-50 transition-transform md:static md:translate-x-0 dark:border-zinc-800 dark:bg-zinc-950 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Conversations"
      >
        <div className="flex items-center justify-between p-3">
          <span className="px-1 text-sm font-semibold">Time-Aware Search</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 md:hidden"
            aria-label="Close conversations"
          >
            ✕
          </button>
        </div>
        <div className="px-3 pb-2">
          <button
            onClick={onNew}
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm font-medium hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            + New chat
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-xs text-zinc-500">No conversations yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((c) => (
                <li key={c.id} className="group relative">
                  <button
                    onClick={() => onSelect(c.id)}
                    aria-current={c.id === activeId ? "page" : undefined}
                    className={`w-full rounded-md px-2 py-2 pr-8 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${
                      c.id === activeId
                        ? "bg-zinc-200/70 dark:bg-zinc-800"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    }`}
                  >
                    <span className="block truncate text-sm">{c.title}</span>
                    <span className="block text-[11px] text-zinc-500">{when(c.updated_at)}</span>
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete "${c.title}"?`)) onDelete(c.id);
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-zinc-400 opacity-0 hover:bg-zinc-200 hover:text-zinc-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    aria-label={`Delete conversation ${c.title}`}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden
                    >
                      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </aside>
    </>
  );
}

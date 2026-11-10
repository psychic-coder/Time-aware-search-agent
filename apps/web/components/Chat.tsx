"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Sidebar from "./Sidebar";
import Composer from "./Composer";
import Message from "./Message";
import {
  ApiError,
  deleteConversation,
  getConversation,
  listConversations,
  streamChat,
  type ConversationSummary,
} from "@/lib/api";
import { getClientId } from "@/lib/clientId";
import type { ServerEvent } from "@/lib/sse";
import type { UiMessage } from "@/lib/types";

const SUGGESTIONS = [
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  "What did I ask you on 3 November? Is your answer still correct today?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
];

let seq = 0;
const localId = () => `local-${Date.now()}-${seq++}`;

export default function Chat() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  useEffect(() => setClientId(getClientId()), []);

  const refreshList = useCallback(async (cid: string) => {
    try {
      setConversations(await listConversations(cid));
      setBanner(null);
    } catch (e) {
      setBanner((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (clientId) void refreshList(clientId);
  }, [clientId, refreshList]);

  // Auto-scroll while streaming unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const updateLast = (fn: (m: UiMessage) => UiMessage) =>
    setMessages((prev) => {
      const next = [...prev];
      const i = next.length - 1;
      if (i >= 0 && next[i]!.role === "assistant") next[i] = fn(next[i]!);
      return next;
    });

  const send = useCallback(
    async (text: string) => {
      if (!clientId || streaming) return;
      const message = text.trim();
      if (!message) return;
      stickToBottom.current = true;
      const now = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        {
          id: localId(),
          role: "user",
          content: message,
          createdAt: now,
          sources: [],
          trail: [],
          assumptions: [],
          streaming: false,
        },
        {
          id: localId(),
          role: "assistant",
          content: "",
          createdAt: now,
          sources: [],
          trail: [],
          assumptions: [],
          streaming: true,
        },
      ]);
      setStreaming(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const onEvent = (e: ServerEvent) => {
        switch (e.type) {
          case "conversation":
            if (activeIdRef.current !== e.id) {
              setActiveId(e.id);
              setConversations((prev) =>
                prev.some((c) => c.id === e.id)
                  ? prev
                  : [{ id: e.id, title: e.title, created_at: now, updated_at: now }, ...prev],
              );
            }
            break;
          case "status":
            updateLast((m) => ({ ...m, trail: [...m.trail, { kind: "status", text: e.text }] }));
            break;
          case "plan":
            updateLast((m) => ({ ...m, assumptions: e.assumptions }));
            break;
          case "search":
            updateLast((m) => {
              const trail = [...m.trail];
              const idx = trail.findIndex((t) => t.kind === "search" && t.text === e.q);
              const item = { kind: "search" as const, text: e.q, state: e.state, count: e.count };
              if (idx >= 0) trail[idx] = item;
              else trail.push(item);
              return { ...m, trail };
            });
            break;
          case "token":
            updateLast((m) => ({ ...m, content: m.content + e.text }));
            break;
          case "sources":
            updateLast((m) => ({ ...m, sources: e.sources }));
            break;
          case "done":
            updateLast((m) => ({
              ...m,
              id: e.messageId ?? m.id,
              streaming: false,
              timings: e.timings,
              searchCalls: e.searchCalls,
            }));
            break;
          case "error":
            updateLast((m) => ({
              ...m,
              streaming: false,
              error: { message: e.message, retryable: e.retryable },
            }));
            break;
        }
      };

      try {
        await streamChat(
          clientId,
          { conversationId: activeIdRef.current, message },
          onEvent,
          ctrl.signal,
        );
        updateLast((m) =>
          m.streaming
            ? {
                ...m,
                streaming: false,
                error: m.content
                  ? undefined
                  : { message: "The answer ended unexpectedly.", retryable: true },
              }
            : m,
        );
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          updateLast((m) => ({ ...m, streaming: false, stopped: true }));
        } else {
          const err = e instanceof ApiError ? e : new ApiError("Something went wrong.", true);
          updateLast((m) => ({
            ...m,
            streaming: false,
            error: { message: err.message, retryable: err.retryable },
          }));
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        void refreshList(clientId);
      }
    },
    [clientId, streaming, refreshList],
  );

  const stop = () => abortRef.current?.abort();

  const retry = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    setMessages((prev) => prev.slice(0, -2));
    void send(lastUser.content);
  };

  const openConversation = async (id: string) => {
    if (!clientId || streaming) return;
    setSidebarOpen(false);
    setActiveId(id);
    try {
      const { messages: stored } = await getConversation(clientId, id);
      setMessages(
        stored.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          sources: m.sources.map((s) => ({
            n: s.n,
            title: s.title,
            url: s.url,
            published_date: s.published_date,
          })),
          trail: [],
          assumptions: [],
          streaming: false,
        })),
      );
      stickToBottom.current = true;
    } catch (e) {
      setBanner((e as Error).message);
    }
  };

  const newChat = () => {
    if (streaming) stop();
    setActiveId(null);
    setMessages([]);
    setSidebarOpen(false);
  };

  const remove = async (id: string) => {
    if (!clientId) return;
    try {
      await deleteConversation(clientId, id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === activeId) newChat();
    } catch (e) {
      setBanner((e as Error).message);
    }
  };

  return (
    <div className="flex h-dvh">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={openConversation}
        onNew={newChat}
        onDelete={remove}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 md:hidden dark:border-zinc-800">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-2 text-zinc-600 hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-zinc-300 dark:hover:bg-zinc-800"
            aria-label="Open conversations"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-sm font-medium">Time-Aware Search</span>
        </header>

        {banner && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
          >
            <span>{banner}</span>
            <button className="underline" onClick={() => clientId && refreshList(clientId)}>
              Retry
            </button>
          </div>
        )}

        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            {messages.length === 0 ? (
              <EmptyState onPick={(s) => void send(s)} disabled={!clientId} />
            ) : (
              <div className="space-y-6" aria-live="polite">
                {messages.map((m, i) => (
                  <Message
                    key={m.id}
                    message={m}
                    onRetry={i === messages.length - 1 ? retry : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <Composer
          onSend={(t) => void send(t)}
          onStop={stop}
          streaming={streaming}
          disabled={!clientId}
        />
      </main>
    </div>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (s: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center pt-[12vh] text-center">
      <h1 className="text-2xl font-semibold tracking-tight">What do you want to check?</h1>
      <p className="mt-2 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
        I search the web and remember what we discussed, and when, so you can ask what changed
        since.
      </p>
      <div className="mt-8 grid w-full gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            disabled={disabled}
            onClick={() => onPick(s)}
            className="rounded-xl border border-zinc-200 px-4 py-3 text-left text-sm text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
}

const MAX = 4000;

export default function Composer({ onSend, onStop, streaming, disabled }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    if (!streaming) ref.current?.focus();
  }, [streaming]);

  // auto-grow
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    if (streaming || disabled || !text.trim() || text.length > MAX) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="border-t border-zinc-200 bg-white/90 px-4 pb-4 pt-3 backdrop-blur dark:border-zinc-800 dark:bg-[#0b0b0d]/90">
      <form
        className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-zinc-300 bg-white p-2 shadow-sm focus-within:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            streaming
              ? "Answering… press Stop to interrupt"
              : "Ask anything — e.g. “has anything changed since Monday?”"
          }
          className="max-h-[220px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] outline-none placeholder:text-zinc-400"
          disabled={disabled}
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-xl bg-zinc-200 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !text.trim() || text.length > MAX}
            className="rounded-xl bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Send
          </button>
        )}
      </form>
      <p className="mx-auto mt-1.5 max-w-3xl px-1 text-[11px] text-zinc-400">
        Enter to send · Shift+Enter for a new line
        {text.length > MAX * 0.9 ? ` · ${text.length}/${MAX}` : ""}
      </p>
    </div>
  );
}

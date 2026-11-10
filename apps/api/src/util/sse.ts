import type { Response } from "express";

/** Every SSE frame is `data: {"type": ..., ...}\n\n`. One parser on the client, no named events. */
export type SseEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "status"; stage: string; text: string }
  | { type: "plan"; intent: string; assumptions: string[]; queries: string[] }
  | { type: "search"; q: string; state: "start" | "done" | "cached" | "failed"; count: number }
  | { type: "token"; text: string }
  | {
      type: "sources";
      sources: { n: number; title: string; url: string; published_date: string | null }[];
    }
  | {
      type: "done";
      messageId: string | null;
      timings: {
        memory_ms: number;
        plan_ms: number;
        search_ms: number;
        ttft_ms: number | null;
        total_ms: number;
      };
      models: string[];
      searchCalls: number;
    }
  | { type: "error"; message: string; retryable: boolean };

export type Emit = (e: SseEvent) => void;

export function openSse(res: Response): { emit: Emit; close: () => void } {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": open\n\n");

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15_000);

  const emit: Emit = (e) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const close = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  return { emit, close };
}

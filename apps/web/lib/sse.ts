/**
 * Minimal SSE parser for fetch + ReadableStream (EventSource can't POST).
 * Server frames are `data: {json}\n\n`; comment lines (": ping") are ignored.
 */
export type ServerEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "status"; stage: string; text: string }
  | { type: "plan"; intent: string; assumptions: string[]; queries: string[] }
  | { type: "search"; q: string; state: "start" | "done" | "cached" | "failed"; count: number }
  | { type: "token"; text: string }
  | { type: "sources"; sources: SourceRef[] }
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

export interface SourceRef {
  n: number;
  title: string;
  url: string;
  published_date: string | null;
}

export class SseParser {
  private buf = "";

  /** Feed a decoded text chunk; returns complete events (malformed frames are skipped). */
  push(chunk: string): ServerEvent[] {
    this.buf += chunk.replace(/\r\n/g, "\n");
    const out: ServerEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        const ev = JSON.parse(data) as ServerEvent;
        if (ev && typeof ev === "object" && typeof (ev as { type?: unknown }).type === "string")
          out.push(ev);
      } catch {
        /* ignore malformed frame */
      }
    }
    return out;
  }
}

export async function consumeSse(res: Response, onEvent: (e: ServerEvent) => void): Promise<void> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev);
  }
  for (const ev of parser.push(decoder.decode() + "\n\n")) onEvent(ev);
}

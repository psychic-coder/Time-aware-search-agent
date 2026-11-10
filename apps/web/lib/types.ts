import type { SourceRef } from "./sse";

export interface TrailItem {
  kind: "status" | "search";
  text: string;
  state?: "start" | "done" | "cached" | "failed";
  count?: number;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sources: SourceRef[];
  trail: TrailItem[];
  assumptions: string[];
  streaming: boolean;
  timings?: {
    memory_ms: number;
    plan_ms: number;
    search_ms: number;
    ttft_ms: number | null;
    total_ms: number;
  };
  searchCalls?: number;
  error?: { message: string; retryable: boolean };
  stopped?: boolean;
}

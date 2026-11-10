import OpenAI, { APIError } from "openai";
import type { AppConfig } from "../config.js";
import type { Logger } from "../util/logger.js";
import { stripThink, ThinkStripper } from "./strip.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface CompleteOptions {
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** total time budget for one attempt */
  timeoutMs: number;
  signal?: AbortSignal;
  purpose: "planner" | "repair" | "reformulate" | "synth";
}
export interface StreamOptions extends CompleteOptions {
  firstTokenTimeoutMs: number;
  onToken: (text: string) => void;
}
export interface LlmResult {
  text: string;
  model: string;
  attempts: number;
}
export interface Llm {
  complete(o: CompleteOptions): Promise<LlmResult>;
  stream(o: StreamOptions): Promise<LlmResult>;
  models(): string[];
}

export class LlmUnavailableError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    readonly kind: "rate_limited" | "network" | "other" = "other",
  ) {
    super(message);
  }
}
export class LlmAuthError extends Error {
  readonly retryable = false;
}
/** Failure after tokens already reached the user: cannot fail over transparently. */
export class LlmStreamBrokenError extends Error {
  readonly retryable = true;
}
export class AbortedError extends Error {}

/* ------------------------------------------------------------------ */
/* Model discovery & ranking                                           */
/* ------------------------------------------------------------------ */

const REASONING_RE = /(r1|reason|think|chimera|qwq)/i;
const NON_CHAT_RE = /(prover|ocr|math|coder|vl\b|vision|embed)/i;

/** Pure + unit-tested: free DeepSeek ids, chat/V3 family first (newest first), R1 family last. */
export function rankModels(ids: string[]): string[] {
  const free = [...new Set(ids)].filter((id) => /deepseek/i.test(id) && id.endsWith(":free"));
  const score = (id: string): number => {
    let s = 0;
    if (NON_CHAT_RE.test(id)) s -= 5000;
    if (REASONING_RE.test(id)) s -= 1000;
    if (/chat|v3|v4/i.test(id)) s += 100;
    const v = id.match(/v(\d+)(?:\.(\d+))?/i);
    if (v) s += Number(v[1]) * 10 + Number(v[2] ?? 0);
    if (/^deepseek\//.test(id)) s += 5; // first-party listing over fine-tunes
    return s;
  };
  return free.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

export function isReasoningModel(id: string): boolean {
  return REASONING_RE.test(id);
}

/* ------------------------------------------------------------------ */
/* Rate control                                                        */
/* ------------------------------------------------------------------ */

export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.queue = this.queue.filter((f) => f !== go);
          reject(new AbortedError("aborted"));
        };
        const go = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        this.queue.push(go);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

/** Approximate RPM limiter. Waits (bounded) instead of failing. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly perMinute: number,
    private readonly burst = Math.max(2, Math.ceil(perMinute / 3)),
  ) {
    this.tokens = this.burst;
  }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
  }
  async take(signal?: AbortSignal, maxWaitMs = 10_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      if (Date.now() - t0 > maxWaitMs)
        throw new LlmUnavailableError("local rate limit reached", "rate_limited");
      await sleep(Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute), signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* OpenRouter client with fallback chain                               */
/* ------------------------------------------------------------------ */

type AttemptError = {
  retrySameModel: boolean;
  retryAfterMs: number | null;
  fatal: boolean;
  reason: string;
};

function classify(err: unknown, timedOut: boolean): AttemptError {
  if (timedOut)
    return { retrySameModel: true, retryAfterMs: null, fatal: false, reason: "timeout" };
  // Connection errors subclass APIError but carry no HTTP status: treat as network, retry same model.
  if (err instanceof APIError && typeof err.status === "number") {
    const status = err.status;
    const ra = err.headers?.get?.("retry-after");
    const retryAfterMs = ra && !Number.isNaN(Number(ra)) ? Number(ra) * 1000 : null;
    if (status === 401 || status === 403)
      return { retrySameModel: false, retryAfterMs: null, fatal: true, reason: `auth ${status}` };
    if (status === 429 || status >= 500)
      return { retrySameModel: true, retryAfterMs, fatal: false, reason: `http ${status}` };
    // 400/404/402 etc: model-specific problem (gone, unsupported param, needs credits) → next model.
    return { retrySameModel: false, retryAfterMs: null, fatal: false, reason: `http ${status}` };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "empty output")
    return { retrySameModel: true, retryAfterMs: null, fatal: false, reason: "empty output" };
  return {
    retrySameModel: true,
    retryAfterMs: null,
    fatal: false,
    reason: `network: ${msg.slice(0, 120)}`,
  };
}

export class OpenRouterLlm implements Llm {
  private client: OpenAI;
  private ranked: string[] = [];
  private cooldownUntil = new Map<string, number>();
  private failures = new Map<string, number>();
  private sem: Semaphore;
  private bucket: TokenBucket;
  private isOpenRouter: boolean;

  constructor(
    private readonly cfg: AppConfig,
    private readonly log: Logger,
    fetchImpl?: typeof fetch, // injectable for tests
  ) {
    this.client = new OpenAI({
      apiKey: cfg.openrouterKey,
      baseURL: cfg.llmBaseUrl,
      maxRetries: 0, // we own retries
      defaultHeaders: { "HTTP-Referer": cfg.appUrl, "X-Title": cfg.appName },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    this.sem = new Semaphore(cfg.llmConcurrency);
    this.bucket = new TokenBucket(cfg.llmRpm);
    this.isOpenRouter = cfg.llmBaseUrl.includes("openrouter.ai");
  }

  models(): string[] {
    return [...this.ranked];
  }

  /** Boot-time discovery. Throws with an actionable message if nothing usable exists. */
  async init(): Promise<string[]> {
    if (this.cfg.llmModelsOverride?.length) {
      this.ranked = this.cfg.llmModelsOverride;
      this.log.info("llm models (from LLM_MODELS)", { models: this.ranked });
      return this.ranked;
    }
    const res = await fetch(`${this.cfg.llmBaseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${this.cfg.openrouterKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`model discovery failed: GET /models → HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => typeof x === "string");
    this.ranked = rankModels(ids);
    if (this.ranked.length === 0) {
      throw new Error(
        "No free DeepSeek models (id contains 'deepseek' and ends with ':free') are listed by OpenRouter right now. " +
          "Set LLM_MODELS in .env to a model id you can use, e.g. LLM_MODELS=deepseek/deepseek-chat-v3.1:free",
      );
    }
    this.log.info("llm models (discovered)", { models: this.ranked });
    return this.ranked;
  }

  private order(): string[] {
    const now = Date.now();
    const warm = this.ranked.filter((m) => (this.cooldownUntil.get(m) ?? 0) <= now);
    const cold = this.ranked.filter((m) => (this.cooldownUntil.get(m) ?? 0) > now);
    return [...warm, ...cold]; // cooling models are tried last, never skipped entirely
  }

  private noteFailure(model: string) {
    const n = (this.failures.get(model) ?? 0) + 1;
    this.failures.set(model, n);
    if (n >= 2) {
      this.cooldownUntil.set(model, Date.now() + 60_000);
      this.failures.set(model, 0);
      this.log.warn("llm model cooling down", { model, seconds: 60 });
    }
  }
  private noteSuccess(model: string) {
    this.failures.set(model, 0);
  }

  private extraBody(): Record<string, unknown> {
    // Never let reasoning text reach us in the content channel when the provider can separate it.
    return this.isOpenRouter ? { reasoning: { exclude: true } } : {};
  }

  async complete(o: CompleteOptions): Promise<LlmResult> {
    return this.run(o, async (model, signal) => {
      const res = await this.client.chat.completions.create(
        {
          model,
          messages: o.messages,
          temperature: o.temperature,
          max_tokens: o.maxTokens,
          stream: false,
          ...this.extraBody(),
        },
        { signal },
      );
      const text = stripThink(res.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new Error("empty output");
      return text;
    });
  }

  async stream(o: StreamOptions): Promise<LlmResult> {
    return this.run(
      o,
      async (model, signal, markFirstChunk) => {
        const stream = await this.client.chat.completions.create(
          {
            model,
            messages: o.messages,
            temperature: o.temperature,
            max_tokens: o.maxTokens,
            stream: true,
            ...this.extraBody(),
          },
          { signal },
        );
        const stripper = new ThinkStripper();
        let full = "";
        for await (const chunk of stream) {
          markFirstChunk(); // any chunk (even reasoning deltas) proves liveness
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (!delta) continue;
          const visible = stripper.push(delta);
          if (visible) {
            full += visible;
            o.onToken(visible);
          }
        }
        const tail = stripper.flush();
        if (tail) {
          full += tail;
          o.onToken(tail);
        }
        if (!full.trim()) throw new Error("empty output");
        return full;
      },
      true,
    );
  }

  /**
   * Fallback chain: each model gets 1 try + 1 retry (jittered backoff, honouring Retry-After),
   * then the next model. For streams, failover is only transparent before the first visible token.
   */
  private async run(
    o: CompleteOptions & { firstTokenTimeoutMs?: number; onToken?: (t: string) => void },
    attemptFn: (model: string, signal: AbortSignal, markFirstChunk: () => void) => Promise<string>,
    streaming = false,
  ): Promise<LlmResult> {
    if (this.ranked.length === 0) throw new LlmUnavailableError("no models configured");
    let attempts = 0;
    let lastReason = "unknown";
    let emitted = false;
    const onToken = o.onToken;
    if (streaming && onToken) {
      o = {
        ...o,
        onToken: (t: string) => {
          emitted = true;
          onToken(t);
        },
      };
    }
    for (const model of this.order()) {
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        if (o.signal?.aborted) throw new AbortedError("aborted");
        attempts++;
        await this.bucket.take(o.signal);
        const release = await this.sem.acquire(o.signal);
        const ctrl = new AbortController();
        let timedOut = false;
        const onAbort = () => ctrl.abort();
        o.signal?.addEventListener("abort", onAbort, { once: true });
        const total = setTimeout(() => {
          timedOut = true;
          ctrl.abort();
        }, o.timeoutMs);
        let firstTimer: NodeJS.Timeout | undefined;
        if (streaming && o.firstTokenTimeoutMs) {
          firstTimer = setTimeout(() => {
            timedOut = true;
            ctrl.abort();
          }, o.firstTokenTimeoutMs);
        }
        const t0 = Date.now();
        try {
          const text = await attemptFn(model, ctrl.signal, () => {
            if (firstTimer) {
              clearTimeout(firstTimer);
              firstTimer = undefined;
            }
          });
          this.noteSuccess(model);
          this.log.debug("llm ok", { model, purpose: o.purpose, ms: Date.now() - t0, attempts });
          return { text, model, attempts };
        } catch (err) {
          if (o.signal?.aborted) throw new AbortedError("aborted");
          const c = classify(err, timedOut);
          lastReason = c.reason;
          this.log.warn("llm attempt failed", {
            model,
            purpose: o.purpose,
            reason: c.reason,
            try: tryNo + 1,
          });
          if (c.fatal)
            throw new LlmAuthError(
              "The LLM provider rejected the API key (check MODEL_API_KEY).",
            );
          if (emitted) throw new LlmStreamBrokenError(`stream broke mid-answer (${c.reason})`);
          this.noteFailure(model);
          if (!c.retrySameModel || tryNo === 1) break;
          if (c.retryAfterMs !== null && c.retryAfterMs > 8000) break; // long wait: switch model instead
          const backoff = (c.retryAfterMs ?? 600) + Math.random() * 400;
          await sleep(Math.min(backoff, 4000), o.signal);
        } finally {
          clearTimeout(total);
          if (firstTimer) clearTimeout(firstTimer);
          o.signal?.removeEventListener("abort", onAbort);
          release();
        }
      }
    }
    const kind = lastReason.startsWith("network")
      ? "network"
      : /429|timeout|http 5/.test(lastReason)
        ? "rate_limited"
        : "other";
    throw new LlmUnavailableError(`all models failed (last: ${lastReason})`, kind);
  }
}

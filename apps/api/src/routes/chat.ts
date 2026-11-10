import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runChat, type Deps } from "../pipeline/orchestrator.js";
import { openSse } from "../util/sse.js";
import { normalizeTimeZone } from "../util/time.js";
import { logger } from "../util/logger.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  conversationId: z.string().regex(UUID_RE).nullish(),
  message: z
    .string()
    .trim()
    .min(1, "message is empty")
    .max(4000, "message is too long (max 4,000 characters)"),
});

/** Sliding-window limiter per client (in-memory; fine for a single-process MVP). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max = 30,
    private readonly windowMs = 10 * 60_000,
  ) {}
  check(key: string, now = Date.now()): { ok: boolean; retryAfterS: number } {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return {
        ok: false,
        retryAfterS: Math.ceil((this.windowMs - (now - (arr[0] as number))) / 1000),
      };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true, retryAfterS: 0 };
  }
}

export function clientIdOf(req: Request): string | null {
  const v = req.header("x-client-id");
  return v && UUID_RE.test(v) ? v.toLowerCase() : null;
}

export function chatRouter(deps: Deps, limiter = new RateLimiter()): Router {
  const r = Router();
  r.post("/api/chat", async (req, res) => {
    const clientId = clientIdOf(req);
    if (!clientId)
      return res
        .status(400)
        .json({ error: "Missing or invalid X-Client-Id header (expected a UUID)." });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const rl = limiter.check(clientId);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterS));
      return res.status(429).json({
        error: `You're sending messages quickly — please wait about ${Math.ceil(rl.retryAfterS / 60)} min and try again.`,
      });
    }

    const requestId = randomUUID().slice(0, 8);
    const ctrl = new AbortController();
    // Abort in-flight LLM/search work when the client disconnects (Stop button, closed tab, network loss).
    res.on("close", () => {
      if (!res.writableFinished) ctrl.abort();
    });
    const { emit, close } = openSse(res);
    try {
      await runChat(
        deps,
        {
          requestId,
          clientId,
          conversationId: parsed.data.conversationId ?? null,
          message: parsed.data.message,
          tz: normalizeTimeZone(req.header("x-timezone")),
          signal: ctrl.signal,
        },
        emit,
      );
    } catch (e) {
      // Safety net for unexpected throws outside the pipeline's own handling (e.g. a DB error).
      logger.error("chat route failed", { requestId, error: e instanceof Error ? e : String(e) });
      emit({
        type: "error",
        message: "Something went wrong on our side. Please retry.",
        retryable: true,
      });
    } finally {
      close();
    }
  });
  return r;
}

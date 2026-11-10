import { describe, expect, it } from "vitest";
import { LlmAuthError, LlmUnavailableError, OpenRouterLlm } from "../src/llm/client.js";
import type { AppConfig } from "../src/config.js";
import { silentLogger } from "../src/util/logger.js";

const cfg = (models: string[]): AppConfig => ({
  openrouterKey: "sk-or-test-key-123456",
  tavilyKey: "tvly-test-123456",
  llmModelsOverride: models,
  llmBaseUrl: "https://openrouter.ai/api/v1",
  llmConcurrency: 2,
  llmRpm: 1000,
  appUrl: "http://localhost:3000",
  appName: "test",
  searchMaxCalls: 12,
  port: 4000,
  webOrigins: [],
  dbPath: ":memory:",
});

type Behavior = (model: string) => Response | Promise<Response>;

function fakeFetch(behavior: Behavior, seen: string[]): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    seen.push(body.model);
    return behavior(body.model);
  }) as typeof fetch;
}

const ok = (content: string) =>
  new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: "nope" } }), {
    status: code,
    headers: { "content-type": "application/json", ...headers },
  });

function sse(chunks: string[], delayFirstMs = 0): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      if (delayFirstMs) await new Promise((r) => setTimeout(r, delayFirstMs));
      for (const c of chunks)
        ctrl.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })}\n\n`,
          ),
        );
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const opts = {
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0,
  maxTokens: 50,
  timeoutMs: 3000,
  purpose: "planner" as const,
};

describe("OpenRouterLlm fallback chain", () => {
  it("429 → one retry on same model → next model", async () => {
    const seen: string[] = [];
    const llm = new OpenRouterLlm(
      cfg(["a:free", "b:free"]),
      silentLogger,
      fakeFetch((m) => (m === "a:free" ? status(429, { "retry-after": "0" }) : ok("hello")), seen),
    );
    await llm.init();
    const r = await llm.complete(opts);
    expect(r.text).toBe("hello");
    expect(r.model).toBe("b:free");
    expect(seen).toEqual(["a:free", "a:free", "b:free"]);
  });

  it("404 (model gone) skips straight to the next model", async () => {
    const seen: string[] = [];
    const llm = new OpenRouterLlm(
      cfg(["gone:free", "b:free"]),
      silentLogger,
      fakeFetch((m) => (m === "gone:free" ? status(404) : ok("ok")), seen),
    );
    await llm.init();
    expect((await llm.complete(opts)).model).toBe("b:free");
    expect(seen).toEqual(["gone:free", "b:free"]);
  });

  it("429 on every model → LlmUnavailableError (friendly, retryable)", async () => {
    const llm = new OpenRouterLlm(
      cfg(["a:free", "b:free"]),
      silentLogger,
      fakeFetch(() => status(429, { "retry-after": "0" }), []),
    );
    await llm.init();
    await expect(llm.complete(opts)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("401 → LlmAuthError immediately (no pointless retries)", async () => {
    const seen: string[] = [];
    const llm = new OpenRouterLlm(
      cfg(["a:free", "b:free"]),
      silentLogger,
      fakeFetch(() => status(401), seen),
    );
    await llm.init();
    await expect(llm.complete(opts)).rejects.toBeInstanceOf(LlmAuthError);
    expect(seen).toEqual(["a:free"]);
  });

  it("empty output is treated as a failure", async () => {
    const llm = new OpenRouterLlm(
      cfg(["a:free", "b:free"]),
      silentLogger,
      fakeFetch((m) => (m === "a:free" ? ok("<think>only thoughts</think>") : ok("real")), []),
    );
    await llm.init();
    expect((await llm.complete(opts)).text).toBe("real");
  });

  it("stream: first-token timeout fails over transparently; think blocks never reach onToken", async () => {
    const tokens: string[] = [];
    const llm = new OpenRouterLlm(
      cfg(["slow:free", "fast:free"]),
      silentLogger,
      fakeFetch(
        (m) => (m === "slow:free" ? sse(["late"], 1500) : sse(["<think>x</think>", "Hel", "lo"])),
        [],
      ),
    );
    await llm.init();
    const r = await llm.stream({
      ...opts,
      purpose: "synth",
      firstTokenTimeoutMs: 100,
      onToken: (t) => tokens.push(t),
    });
    expect(r.model).toBe("fast:free");
    expect(tokens.join("")).toBe("Hello");
  }, 10_000);
});

describe("network failures", () => {
  it("connection errors are retried and surface as kind=network", async () => {
    const seen: string[] = [];
    const llm = new OpenRouterLlm(cfg(["a:free", "b:free"]), silentLogger, (async (
      _u: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seen.push((JSON.parse(String(init?.body)) as { model: string }).model);
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await llm.init();
    const err = await llm.complete(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).kind).toBe("network");
    expect(seen).toEqual(["a:free", "a:free", "b:free", "b:free"]);
  });
});

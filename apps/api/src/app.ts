import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import type { Deps } from "./pipeline/orchestrator.js";
import { chatRouter } from "./routes/chat.js";
import { conversationsRouter } from "./routes/conversations.js";
import { PROMPT_VERSION } from "./pipeline/prompts.js";
import { logger } from "./util/logger.js";

export function createApp(deps: Deps, webOrigins: string[]): express.Express {
  const { llm, memory } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      // configured origins, plus any localhost / 127.0.0.1 port (opening the app via 127.0.0.1 shouldn't break CORS)
      origin: (origin, cb) =>
        cb(
          null,
          !origin ||
            webOrigins.includes(origin) ||
            /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin),
        ),
      allowedHeaders: ["Content-Type", "X-Client-Id", "X-Timezone"],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, models: llm.models(), promptVersion: PROMPT_VERSION }),
  );
  app.use(chatRouter(deps));
  app.use(conversationsRouter(memory));
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed")
      return res.status(400).json({ error: "invalid JSON body" });
    if (err.type === "entity.too.large")
      return res.status(413).json({ error: "request too large" });
    logger.error("unhandled route error", { error: err });
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  return app;
}

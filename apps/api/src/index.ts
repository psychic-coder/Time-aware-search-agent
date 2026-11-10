import { ConfigError, loadConfig } from "./config.js";
import { OpenRouterLlm } from "./llm/client.js";
import { MemoryStore } from "./pipeline/memory.js";
import { SearchService, TavilyProvider } from "./pipeline/search.js";
import { createApp } from "./app.js";
import { PROMPT_VERSION } from "./pipeline/prompts.js";
import { logger } from "./util/logger.js";

function fatal(msg: string): never {
  const bar = "─".repeat(72);
  process.stderr.write(`\n${bar}\n[api] cannot start\n\n${msg}\n${bar}\n\n`);
  process.exit(1);
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) fatal(e.message);
    throw e;
  }

  const llm = new OpenRouterLlm(cfg, logger);
  try {
    await llm.init();
  } catch (e) {
    fatal(
      `LLM model discovery failed: ${(e as Error).message}\n` +
        "Check OPENROUTER_API_KEY and network access, or set LLM_MODELS in .env to skip discovery.",
    );
  }

  const memory = new MemoryStore(cfg.dbPath);
  const search = new SearchService(new TavilyProvider(cfg.tavilyKey));
  const deps = { llm, search, memory, log: logger, maxSearchCalls: cfg.searchMaxCalls };

  const app = createApp(deps, cfg.webOrigins);

  const server = app.listen(cfg.port, () => {
    logger.info("api listening", {
      port: cfg.port,
      db: cfg.dbPath,
      promptVersion: PROMPT_VERSION,
      webOrigins: cfg.webOrigins,
    });
  });

  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { sig });
    server.close(() => {
      memory.close();
      process.exit(0);
    });
    server.closeAllConnections?.(); // end open SSE streams
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (r) =>
    logger.error("unhandledRejection", { error: r instanceof Error ? r : String(r) }),
  );
}

main().catch((e) => fatal((e as Error).stack ?? String(e)));

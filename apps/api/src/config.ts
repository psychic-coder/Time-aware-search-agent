import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ (dev) and dist/src/ (build) both resolve to apps/api
export const API_ROOT = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");
export const REPO_ROOT = path.resolve(API_ROOT, "../..");
export const DEFAULT_DB_PATH = path.join(API_ROOT, "data", "agent.db");

dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true } as dotenv.DotenvConfigOptions);

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const int = (def: number, min: number, max: number) =>
  z.preprocess(emptyToUndef, z.coerce.number().int().min(min).max(max).default(def));

const EnvSchema = z.object({
  OPENROUTER_API_KEY: z.preprocess(emptyToUndef, z.string().min(10, "looks too short")),
  TAVILY_API_KEY: z.preprocess(emptyToUndef, z.string().min(10, "looks too short")),
  LLM_MODELS: z.preprocess(emptyToUndef, z.string().optional()),
  LLM_BASE_URL: z.preprocess(
    emptyToUndef,
    z.string().url().default("https://openrouter.ai/api/v1"),
  ),
  LLM_CONCURRENCY: int(2, 1, 16),
  LLM_RPM: int(18, 1, 1000),
  APP_URL: z.preprocess(emptyToUndef, z.string().default("http://localhost:3000")),
  APP_NAME: z.preprocess(emptyToUndef, z.string().default("Time-Aware Search Agent")),
  SEARCH_MAX_CALLS_PER_REQUEST: int(12, 1, 50),
  PORT: int(4000, 1, 65535),
  WEB_ORIGIN: z.preprocess(emptyToUndef, z.string().default("http://localhost:3000")),
  DB_PATH: z.preprocess(emptyToUndef, z.string().optional()),
});

export type AppConfig = {
  openrouterKey: string;
  tavilyKey: string;
  llmModelsOverride: string[] | null;
  llmBaseUrl: string;
  llmConcurrency: number;
  llmRpm: number;
  appUrl: string;
  appName: string;
  searchMaxCalls: number;
  port: number;
  webOrigins: string[];
  dbPath: string;
};

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = String(i.path[0] ?? "?");
      const hint =
        key === "OPENROUTER_API_KEY"
          ? "get one at https://openrouter.ai/keys"
          : key === "TAVILY_API_KEY"
            ? "get one at https://app.tavily.com"
            : i.message;
      const missing = env[key] === undefined || String(env[key]).trim() === "";
      return `  - ${key}: ${missing ? "missing" : i.message} (${hint})`;
    });
    throw new ConfigError(
      [
        "Configuration error. Fix these in the repo-root .env file (copy .env.example if you have none):",
        ...lines,
      ].join("\n"),
    );
  }
  const e = parsed.data;
  return {
    openrouterKey: e.OPENROUTER_API_KEY,
    tavilyKey: e.TAVILY_API_KEY,
    llmModelsOverride: e.LLM_MODELS
      ? e.LLM_MODELS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    llmBaseUrl: e.LLM_BASE_URL,
    llmConcurrency: e.LLM_CONCURRENCY,
    llmRpm: e.LLM_RPM,
    appUrl: e.APP_URL,
    appName: e.APP_NAME,
    searchMaxCalls: e.SEARCH_MAX_CALLS_PER_REQUEST,
    port: e.PORT,
    webOrigins: e.WEB_ORIGIN.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dbPath: e.DB_PATH ?? DEFAULT_DB_PATH,
  };
}

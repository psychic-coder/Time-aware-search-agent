/* Tiny structured JSON logger with secret redaction. One line per event. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level =
  (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info";
export function setLogLevel(l: Level): void {
  minLevel = l;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-or-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /sk-[A-Za-z0-9_-]{16,}/g, // generic OpenAI-style
  /tvly-[A-Za-z0-9_-]{8,}/g, // Tavily
  /(api[_-]?key"?\s*[:=]\s*"?)[^"\s,}]+/gi,
  /(Bearer\s+)[A-Za-z0-9._-]+/g,
];

export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) =>
      typeof prefix === "string" && prefix.length < 40 ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = JSON.stringify(
    { t: new Date().toISOString(), level, msg, ...fields },
    (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v),
  );
  const safe = redact(line);
  if (level === "error" || level === "warn") process.stderr.write(safe + "\n");
  else process.stdout.write(safe + "\n");
}

export interface Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
  child(f: Record<string, unknown>): Logger;
}

export function makeLogger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => emit("debug", m, { ...base, ...f }),
    info: (m, f) => emit("info", m, { ...base, ...f }),
    warn: (m, f) => emit("warn", m, { ...base, ...f }),
    error: (m, f) => emit("error", m, { ...base, ...f }),
    child: (f) => makeLogger({ ...base, ...f }),
  };
}

export const logger = makeLogger();

/** A logger that drops everything (tests/eval). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

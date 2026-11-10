/**
 * Stage 2 — durable memory (SQLite + FTS5) and retrieval.
 *
 * Access pattern is "what happened on <date range> about <keywords>", which is exactly
 * an indexed time-range scan + BM25 keyword match. No embeddings needed for the MVP.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import type { ResolvedDate } from "./temporal.js";
import { formatLocal, localDateLabel } from "../util/time.js";

export interface StoredSource {
  n: number;
  title: string;
  url: string;
  published_date: string | null;
  retrieved_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  client_id: string;
  role: "user" | "assistant";
  content: string;
  created_at_utc: string;
  tz: string;
  plan_json: string | null;
  sources_json: string | null;
}

export interface ConversationRow {
  id: string;
  client_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Turn {
  conversationId: string;
  conversationTitle: string;
  at: string; // UTC ISO of the user message (or assistant if orphan)
  user: MessageRow | null;
  assistant: MessageRow | null;
}

export interface RangeRecall {
  range: ResolvedDate;
  turns: Turn[];
}

export interface RecallResult {
  ranges: RangeRecall[];
  keywordTurns: Turn[];
  recent: MessageRow[];
  knownDates: string[]; // local day labels with records, most recent first
  terms: string[];
}

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/schema.sql");

/** Canonical stored timestamp format (Date#toISOString) so lexicographic compare == chronological. */
export const canonIso = (s: string | Date): string => new Date(s).toISOString();

const STOPWORDS = new Set(
  (
    "a an the and or but if then than so of to in on at by for with about from into over under is are was were be been being " +
    "i me my we our us you your it its this that these those what which who whom whose when where why how " +
    "do does did done have has had can could should would will shall may might must not no yes any some all " +
    "ask asked asking tell told answer answered say said still correct right today yesterday tomorrow now " +
    "since ago last next this week month year day days monday tuesday wednesday thursday friday saturday sunday " +
    "january february march april may june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec changed change changes anything something new news " +
    "please thanks thank hi hello hey ok okay them they their there here one ones get got make made just also " +
    "shipped big earlier recently few couple other again know remember"
  ).split(/\s+/),
);

/** Key terms for FTS (e.g. "crm", "postgres", "hosting", "pricing"). Pure, exported for tests. */
export function keyTerms(message: string, max = 8): string[] {
  // Split on punctuation so "node.js" → "node", "js" (matches how FTS5's unicode61 tokenizer indexed it).
  const words = message.toLowerCase().match(/[a-z][a-z0-9]{1,30}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w0 of words) {
    const w = w0;
    if (w.length < 3 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function ftsQuery(terms: string[]): string | null {
  const clean = terms.map((t) => t.replace(/[^a-z0-9]/g, "")).filter((t) => t.length >= 2);
  return clean.length ? clean.map((t) => `"${t}"`).join(" OR ") : null;
}

export class MemoryStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  }

  close(): void {
    this.db.close();
  }

  /* ---------------- conversations ---------------- */

  createConversation(
    clientId: string,
    title: string,
    now = new Date(),
    id = randomUUID(),
  ): ConversationRow {
    const ts = canonIso(now);
    const row: ConversationRow = { id, client_id: clientId, title, created_at: ts, updated_at: ts };
    this.db
      .prepare(
        "INSERT INTO conversations (id, client_id, title, created_at, updated_at) VALUES (@id, @client_id, @title, @created_at, @updated_at)",
      )
      .run(row);
    return row;
  }

  getConversation(clientId: string, id: string): ConversationRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM conversations WHERE id = ? AND client_id = ?")
        .get(id, clientId) as ConversationRow | undefined) ?? null
    );
  }

  listConversations(clientId: string, limit = 100): ConversationRow[] {
    return this.db
      .prepare("SELECT * FROM conversations WHERE client_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(clientId, limit) as ConversationRow[];
  }

  deleteConversation(clientId: string, id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM messages WHERE conversation_id = ? AND client_id = ?")
        .run(id, clientId);
      return this.db
        .prepare("DELETE FROM conversations WHERE id = ? AND client_id = ?")
        .run(id, clientId).changes;
    });
    return tx() > 0;
  }

  /* ---------------- messages ---------------- */

  addMessage(m: {
    conversationId: string;
    clientId: string;
    role: "user" | "assistant";
    content: string;
    tz: string;
    createdAt?: Date | string;
    plan?: unknown;
    sources?: StoredSource[];
    id?: string;
  }): MessageRow {
    const row: MessageRow = {
      id: m.id ?? randomUUID(),
      conversation_id: m.conversationId,
      client_id: m.clientId,
      role: m.role,
      content: m.content,
      created_at_utc: canonIso(m.createdAt ?? new Date()),
      tz: m.tz,
      plan_json: m.plan === undefined ? null : JSON.stringify(m.plan),
      sources_json: m.sources === undefined ? null : JSON.stringify(m.sources),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, client_id, role, content, created_at_utc, tz, plan_json, sources_json)
         VALUES (@id, @conversation_id, @client_id, @role, @content, @created_at_utc, @tz, @plan_json, @sources_json)`,
      )
      .run(row);
    this.db
      .prepare(
        "UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ? AND client_id = ?",
      )
      .run(row.created_at_utc, m.conversationId, m.clientId);
    return row;
  }

  getMessages(clientId: string, conversationId: string): MessageRow[] {
    return this.db
      .prepare(
        "SELECT id, conversation_id, client_id, role, content, created_at_utc, tz, plan_json, sources_json FROM messages WHERE client_id = ? AND conversation_id = ? ORDER BY created_at_utc, rowid_int",
      )
      .all(clientId, conversationId) as MessageRow[];
  }

  /* ---------------- retrieval ---------------- */

  private turnFor(clientId: string, msg: MessageRow): Turn {
    const conv = this.getConversation(clientId, msg.conversation_id);
    const title = conv?.title ?? "(untitled)";
    const cols =
      "id, conversation_id, client_id, role, content, created_at_utc, tz, plan_json, sources_json";
    if (msg.role === "user") {
      const next = this.db
        .prepare(
          `SELECT ${cols} FROM messages WHERE client_id = ? AND conversation_id = ? AND created_at_utc >= ? AND id != ?
           ORDER BY created_at_utc, rowid_int LIMIT 1`,
        )
        .get(clientId, msg.conversation_id, msg.created_at_utc, msg.id) as MessageRow | undefined;
      return {
        conversationId: msg.conversation_id,
        conversationTitle: title,
        at: msg.created_at_utc,
        user: msg,
        assistant: next?.role === "assistant" ? next : null,
      };
    }
    const prev = this.db
      .prepare(
        `SELECT ${cols} FROM messages WHERE client_id = ? AND conversation_id = ? AND created_at_utc <= ? AND id != ?
         ORDER BY created_at_utc DESC, rowid_int DESC LIMIT 1`,
      )
      .get(clientId, msg.conversation_id, msg.created_at_utc, msg.id) as MessageRow | undefined;
    const user = prev?.role === "user" ? prev : null;
    return {
      conversationId: msg.conversation_id,
      conversationTitle: title,
      at: user?.created_at_utc ?? msg.created_at_utc,
      user,
      assistant: msg,
    };
  }

  private toTurns(clientId: string, rows: MessageRow[], exclude: Set<string>): Turn[] {
    const byKey = new Map<string, Turn>();
    for (const r of rows) {
      if (exclude.has(r.id)) continue;
      const t = this.turnFor(clientId, r);
      if (t.user && exclude.has(t.user.id)) continue;
      const key = t.user?.id ?? t.assistant?.id ?? r.id;
      if (!byKey.has(key)) byKey.set(key, t);
    }
    return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  recall(opts: {
    clientId: string;
    conversationId: string | null;
    ranges: ResolvedDate[];
    query: string;
    excludeMessageIds?: string[];
    keywordLimit?: number;
    tz: string;
  }): RecallResult {
    const { clientId } = opts;
    const exclude = new Set(opts.excludeMessageIds ?? []);
    const cols =
      "m.id, m.conversation_id, m.client_id, m.role, m.content, m.created_at_utc, m.tz, m.plan_json, m.sources_json";

    // Last 10 messages of the current conversation (always).
    const recent = opts.conversationId
      ? (
          this.db
            .prepare(
              `SELECT ${cols} FROM messages m WHERE m.client_id = ? AND m.conversation_id = ?
               ORDER BY m.created_at_utc DESC, m.rowid_int DESC LIMIT 11`,
            )
            .all(clientId, opts.conversationId) as MessageRow[]
        )
          .filter((r) => !exclude.has(r.id))
          .slice(0, 10)
          .reverse()
      : [];
    const recentIds = new Set(recent.map((r) => r.id));

    // 1) Everything inside each resolved range (both roles, paired into turns).
    //    Ambiguous ranges also pull their alternative readings so the model can see both.
    const ranges: RangeRecall[] = opts.ranges.map((range) => {
      const windows = [range, ...(range.candidates?.slice(1) ?? [])];
      const rows: MessageRow[] = [];
      for (const w of windows) {
        rows.push(
          ...(this.db
            .prepare(
              `SELECT ${cols} FROM messages m WHERE m.client_id = ? AND m.created_at_utc >= ? AND m.created_at_utc < ?
               ORDER BY m.created_at_utc LIMIT 40`,
            )
            .all(clientId, canonIso(w.start), canonIso(w.end)) as MessageRow[]),
        );
      }
      return { range, turns: this.toTurns(clientId, rows, exclude) };
    });

    // 2) FTS5 BM25 keyword matches; ±3 days around ranges when ranges exist, else global top-N.
    const terms = keyTerms(opts.query);
    const q = ftsQuery(terms);
    let keywordTurns: Turn[] = [];
    if (q) {
      const limit = opts.keywordLimit ?? 5;
      let windowSql = "";
      const params: (string | number)[] = [q, clientId];
      if (opts.ranges.length) {
        const parts: string[] = [];
        for (const r of opts.ranges) {
          parts.push("(m.created_at_utc >= ? AND m.created_at_utc < ?)");
          params.push(
            canonIso(DateTime.fromISO(r.start).minus({ days: 3 }).toJSDate()),
            canonIso(DateTime.fromISO(r.end).plus({ days: 3 }).toJSDate()),
          );
        }
        windowSql = ` AND (${parts.join(" OR ")})`;
      }
      params.push(limit * 3);
      let rows: MessageRow[] = [];
      try {
        rows = this.db
          .prepare(
            `SELECT ${cols} FROM messages_fts f JOIN messages m ON m.rowid_int = f.rowid
             WHERE messages_fts MATCH ? AND m.client_id = ?${windowSql}
             ORDER BY bm25(messages_fts) LIMIT ?`,
          )
          .all(...params) as MessageRow[];
      } catch {
        rows = []; // malformed FTS query should never break a request
      }
      const inRanges = new Set(
        ranges.flatMap((r) => r.turns.flatMap((t) => [t.user?.id, t.assistant?.id])),
      );
      keywordTurns = this.toTurns(
        clientId,
        rows.filter((r) => !recentIds.has(r.id) && !inRanges.has(r.id)),
        exclude,
      ).slice(0, limit);
    }

    return {
      ranges,
      keywordTurns,
      recent,
      knownDates: this.knownDates(clientId, opts.tz, 3, exclude),
      terms,
    };
  }

  /** Most recent distinct local days on which this client asked something. */
  knownDates(clientId: string, tz: string, limit = 3, exclude: Set<string> = new Set()): string[] {
    const rows = this.db
      .prepare(
        "SELECT id, created_at_utc FROM messages WHERE client_id = ? AND role = 'user' ORDER BY created_at_utc DESC LIMIT 200",
      )
      .all(clientId) as { id: string; created_at_utc: string }[];
    const out: string[] = [];
    for (const r of rows) {
      if (exclude.has(r.id)) continue;
      const label = localDateLabel(r.created_at_utc, tz);
      if (!out.includes(label)) out.push(label);
      if (out.length >= limit) break;
    }
    return out;
  }
}

/* ---------------- prompt rendering ---------------- */

const MAX_MEMORY_CHARS = 12_000; // ≈ 3,000 tokens
const OLD_ANSWER_CHARS = 1_200;
const RECENT_MSG_CHARS = 1_500;

function parseSources(json: string | null): StoredSource[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as StoredSource[]) : [];
  } catch {
    return [];
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n).trimEnd()} …[truncated]`;
}

function renderTurn(t: Turn, tz: string): string {
  const lines: string[] = [];
  lines.push(
    `<turn at="${t.at}" local="${formatLocal(t.at, tz)}" conversation="${t.conversationTitle.replace(/"/g, "'")}">`,
  );
  if (t.user) lines.push(`USER: ${truncate(t.user.content, 600)}`);
  if (t.assistant) {
    lines.push(
      `ASSISTANT (${formatLocal(t.assistant.created_at_utc, tz)}): ${truncate(t.assistant.content, OLD_ANSWER_CHARS)}`,
    );
    const src = parseSources(t.assistant.sources_json);
    if (src.length) {
      lines.push("SOURCES USED THEN:");
      for (const s of src.slice(0, 8)) {
        lines.push(
          `  - ${s.title} | ${s.url} | published ${s.published_date ?? "unknown"} | retrieved ${s.retrieved_at}`,
        );
      }
    }
  } else {
    lines.push("ASSISTANT: (no stored answer)");
  }
  lines.push("</turn>");
  return lines.join("\n");
}

/** Renders memory for prompts with a hard size cap. Priority: date-range hits > keyword hits. */
export function renderMemory(
  r: RecallResult,
  tz: string,
): { pastBlock: string; recentBlock: string } {
  const parts: string[] = [];
  let budget = MAX_MEMORY_CHARS;
  const push = (s: string): boolean => {
    if (s.length > budget) return false;
    parts.push(s);
    budget -= s.length;
    return true;
  };

  for (const rr of r.ranges) {
    if (rr.turns.length === 0) {
      push(`NO RECORDS FOUND for "${rr.range.phrase}" (${rr.range.label}).`);
      continue;
    }
    push(`## Records for "${rr.range.phrase}" (${rr.range.label}): ${rr.turns.length} turn(s)`);
    for (const t of rr.turns) if (!push(renderTurn(t, tz))) break;
  }
  if (r.keywordTurns.length) {
    push(
      `## Keyword matches${r.ranges.length ? " near those dates" : ""} (terms: ${r.terms.join(", ")})`,
    );
    for (const t of r.keywordTurns) if (!push(renderTurn(t, tz))) break;
  } else if (r.ranges.length === 0) {
    push(
      `(no keyword matches in past conversations${r.terms.length ? ` for: ${r.terms.join(", ")}` : ""})`,
    );
  }
  push(
    `Dates with records (most recent first): ${r.knownDates.length ? r.knownDates.join("; ") : "none — this user has no prior history"}`,
  );

  const recentLines = r.recent.map(
    (m) =>
      `${m.role.toUpperCase()} (${formatLocal(m.created_at_utc, tz)}): ${truncate(m.content, RECENT_MSG_CHARS)}`,
  );
  return {
    pastBlock: `<past_conversations>\n${parts.join("\n")}\n</past_conversations>`,
    recentBlock: recentLines.length
      ? `<current_conversation>\n${recentLines.join("\n")}\n</current_conversation>`
      : "<current_conversation>(this is the first message of a new conversation)</current_conversation>",
  };
}

/** True when the user referenced a date but no records exist for any of them. */
export function noRecordRanges(r: RecallResult): ResolvedDate[] {
  return r.ranges.filter((x) => x.turns.length === 0).map((x) => x.range);
}

/** Earliest matched turn in the resolved ranges — the deterministic "baseline" for change-since questions. */
export function baselineFromRecall(r: RecallResult): string | null {
  const ts = r.ranges.flatMap((x) => x.turns.map((t) => t.at)).sort();
  return ts[0] ?? null;
}

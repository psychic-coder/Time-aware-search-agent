/**
 * Stage 1 — deterministic temporal resolution.
 *
 * Turns relative phrases ("Monday", "last Tuesday", "3 November", "since Monday", "a few days ago")
 * into absolute ranges computed from LOCAL day boundaries in the user's IANA timezone, returned in UTC.
 * No LLM involved: same input + same `now` + same tz ⇒ same output, which is what makes it testable.
 *
 * Conventions:
 *  - `start` inclusive, `end` exclusive (ISO 8601 UTC).
 *  - Weeks are ISO weeks, Monday–Sunday.
 *  - Bare weekday ("Monday")  = most recent such weekday strictly before today; if today IS that weekday,
 *    prefer last week's and mark ambiguous (candidate: today).
 *  - "last Tuesday"          = Tuesday of the previous calendar week; ambiguous when that differs from the
 *    "most recent Tuesday" reading (both exposed as candidates).
 *  - Explicit date without year ("3 November") = most recent past occurrence (today counts).
 */
import * as chrono from "chrono-node";
import { DateTime } from "luxon";

export type Granularity = "day" | "week" | "range";

export interface DateCandidate {
  start: string;
  end: string;
  label: string;
  reading: string;
}

export interface ResolvedDate {
  phrase: string;
  start: string;
  end: string;
  granularity: Granularity;
  ambiguous: boolean;
  /** Human label in the user's TZ, e.g. "Mon 9 Nov 2026" or "Mon 2 Nov – Sun 8 Nov 2026". */
  label: string;
  /** Primary reading first. Present (length ≥ 2) only when ambiguous with concrete alternatives. */
  candidates?: DateCandidate[];
  note?: string;
  /** character offset in the input, for ordering */
  index: number;
}

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const WD_RE = WEEKDAYS.join("|");
const NUM_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  couple: 2,
  "a couple of": 2,
  "a couple": 2,
};

type Span = { s: number; e: number };

function dayRange(d: DateTime): { start: string; end: string } {
  const s = d.startOf("day");
  return { start: iso(s), end: iso(s.plus({ days: 1 }).startOf("day")) };
}
function iso(d: DateTime): string {
  return d.toUTC().toISO({ suppressMilliseconds: true }) as string;
}
function dayLabel(d: DateTime): string {
  return d.toFormat("ccc d LLL yyyy");
}
function rangeLabel(a: DateTime, bExclusive: DateTime): string {
  const b = bExclusive.minus({ days: 1 });
  if (a.hasSame(b, "day")) return dayLabel(a);
  const sameYear = a.year === b.year;
  return `${a.toFormat(sameYear ? "ccc d LLL" : "ccc d LLL yyyy")} – ${b.toFormat("ccc d LLL yyyy")}`;
}

function mkDay(
  phrase: string,
  index: number,
  d: DateTime,
  ambiguous = false,
  note?: string,
): ResolvedDate {
  return { phrase, index, ...dayRange(d), granularity: "day", ambiguous, label: dayLabel(d), note };
}
function mkRange(
  phrase: string,
  index: number,
  a: DateTime,
  bExclusive: DateTime,
  granularity: Granularity,
  ambiguous = false,
  note?: string,
): ResolvedDate {
  return {
    phrase,
    index,
    start: iso(a.startOf("day")),
    end: iso(bExclusive.startOf("day")),
    granularity,
    ambiguous,
    label: rangeLabel(a.startOf("day"), bExclusive.startOf("day")),
    note,
  };
}
function cand(d: DateTime, reading: string): DateCandidate {
  return { ...dayRange(d), label: dayLabel(d), reading };
}

function parseCount(word: string): number | null {
  const w = word.toLowerCase().trim();
  if (/^\d+$/.test(w)) return Number(w);
  return NUM_WORDS[w] ?? null;
}

export function resolveDates(text: string, now: Date, tz: string): ResolvedDate[] {
  const local = DateTime.fromJSDate(now).setZone(tz);
  if (!local.isValid) throw new Error(`invalid timezone: ${tz}`);
  const today = local.startOf("day");
  const tomorrow = today.plus({ days: 1 });
  const weekStart = today.minus({ days: today.weekday - 1 }); // Monday of this week
  const out: ResolvedDate[] = [];
  const used: Span[] = [];
  const free = (s: number, e: number) => !used.some((u) => s < u.e && e > u.s);

  const rule = (re: RegExp, fn: (m: RegExpExecArray) => ResolvedDate | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const s = m.index;
      const e = s + m[0].length;
      if (!free(s, e)) continue;
      const r = fn(m);
      if (r) {
        out.push(r);
        used.push({ s, e });
      }
    }
  };

  // --- Fixed relative days -------------------------------------------------
  rule(/\b(?:the\s+)?day\s+before\s+yesterday\b/gi, (m) =>
    mkDay(m[0], m.index, today.minus({ days: 2 })),
  );
  rule(/\byesterday\b|\blast\s+night\b/gi, (m) => mkDay(m[0], m.index, today.minus({ days: 1 })));
  rule(/\b(?:earlier\s+)?today\b|\bthis\s+(?:morning|afternoon|evening)\b|\btonight\b/gi, (m) =>
    mkDay(m[0], m.index, today),
  );

  // --- Fuzzy "a few days ago" ---------------------------------------------
  rule(/\b(?:a\s+)?few\s+days\s+(?:ago|back)\b/gi, (m) =>
    mkDay(
      m[0],
      m.index,
      today.minus({ days: 3 }),
      true,
      "'a few days ago' interpreted as 3 days ago",
    ),
  );
  rule(/\bthe\s+other\s+day\b/gi, (m) =>
    mkRange(
      m[0],
      m.index,
      today.minus({ days: 7 }),
      today,
      "range",
      true,
      "'the other day' interpreted as the past 7 days",
    ),
  );

  // --- "N days/weeks ago" ---------------------------------------------------
  rule(
    /\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a\s+couple(?:\s+of)?)\s+(day|week|month)s?\s+(?:ago|back)\b/gi,
    (m) => {
      const n = parseCount(m[1] as string);
      if (n === null || n > 400) return null;
      const unit = (m[2] as string).toLowerCase();
      if (unit === "day")
        return mkDay(m[0], m.index, today.minus({ days: n }), /couple/i.test(m[1] as string));
      if (unit === "week") {
        const d = today.minus({ weeks: n });
        return mkDay(m[0], m.index, d, true, `'${m[0]}' interpreted as ${dayLabel(d)} (±3 days)`);
      }
      const d = today.minus({ months: n });
      return mkDay(m[0], m.index, d, true, `'${m[0]}' interpreted as around ${dayLabel(d)}`);
    },
  );

  // --- Weeks & months --------------------------------------------------------
  rule(/\b(?:last|previous|past)\s+week\b/gi, (m) =>
    mkRange(m[0], m.index, weekStart.minus({ weeks: 1 }), weekStart, "week"),
  );
  rule(/\b(?:earlier\s+)?this\s+week\b/gi, (m) =>
    mkRange(m[0], m.index, weekStart, tomorrow, "week"),
  );
  rule(/\b(?:last|previous)\s+month\b/gi, (m) => {
    const s = today.startOf("month").minus({ months: 1 });
    return mkRange(m[0], m.index, s, today.startOf("month"), "range");
  });
  rule(/\bthis\s+month\b/gi, (m) =>
    mkRange(m[0], m.index, today.startOf("month"), tomorrow, "range"),
  );

  // --- Weekdays ---------------------------------------------------------------
  rule(new RegExp(`\\b(?:(last|this|next|past)\\s+)?(${WD_RE})\\b`, "gi"), (m) => {
    // Not dates: product names ("Monday.com") and events ("Black Friday", "Cyber Monday").
    if (/^\.[a-z]{2,}/i.test(text.slice(m.index + m[0].length))) return null;
    if (/\b(black|cyber|good|super|ash|easter|giving)\s+$/i.test(text.slice(0, m.index)))
      return null;
    const mod = (m[1] ?? "").toLowerCase();
    const target =
      WEEKDAYS.indexOf((m[2] as string).toLowerCase() as (typeof WEEKDAYS)[number]) + 1; // 1..7
    const phrase = m[0];
    // Most recent strictly before today.
    let delta = (today.weekday - target + 7) % 7;
    const isToday = delta === 0;
    if (delta === 0) delta = 7;
    const mostRecent = today.minus({ days: delta });

    if (mod === "last") {
      const prevCal = weekStart.minus({ weeks: 1 }).plus({ days: target - 1 });
      if (prevCal.hasSame(mostRecent, "day")) return mkDay(phrase, m.index, prevCal);
      const r = mkDay(
        phrase,
        m.index,
        prevCal,
        true,
        `'${phrase}' read as the ${prevCal.toFormat("cccc")} of last calendar week (${dayLabel(prevCal)}); could also mean the most recent ${prevCal.toFormat("cccc")} (${dayLabel(mostRecent)})`,
      );
      r.candidates = [cand(prevCal, "previous calendar week"), cand(mostRecent, "most recent")];
      return r;
    }
    if (mod === "this") {
      const d = weekStart.plus({ days: target - 1 });
      return mkDay(
        phrase,
        m.index,
        d,
        d > today,
        d > today ? "refers to a future day this week" : undefined,
      );
    }
    if (mod === "next") {
      const d = weekStart.plus({ weeks: 1, days: target - 1 });
      return mkDay(phrase, m.index, d, true, "future date");
    }
    // bare or "past"
    if (isToday) {
      const r = mkDay(
        phrase,
        m.index,
        mostRecent,
        true,
        `today is ${today.toFormat("cccc")}; '${phrase}' read as last week's (${dayLabel(mostRecent)}), could also mean today`,
      );
      r.candidates = [cand(mostRecent, "last week's"), cand(today, "today")];
      return r;
    }
    return mkDay(phrase, m.index, mostRecent);
  });

  // --- Explicit calendar dates via chrono (only certain day+month or month) ---
  const masked = maskSpans(text, used);
  const refLocal = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0));
  for (const r of chrono.parse(
    masked,
    { instant: refLocal, timezone: 0 },
    { forwardDate: false },
  )) {
    const s = r.index;
    const e = s + r.text.length;
    if (!free(s, e)) continue;
    const st = r.start;
    if (!st.isCertain("month")) continue; // pure relatives were handled above; times are irrelevant
    const year = st.isCertain("year") ? st.get("year") : null;
    const month = st.get("month") as number;
    if (st.isCertain("day")) {
      const day = st.get("day") as number;
      let d = DateTime.fromObject({ year: year ?? today.year, month, day }, { zone: tz });
      if (!d.isValid) continue;
      if (year === null && d > today) d = d.minus({ years: 1 });
      if (r.end && r.end.isCertain("day")) {
        let d2 = DateTime.fromObject(
          {
            year: r.end.isCertain("year") ? (r.end.get("year") as number) : d.year,
            month: r.end.get("month") as number,
            day: r.end.get("day") as number,
          },
          { zone: tz },
        );
        if (d2 < d) d2 = d2.plus({ years: 1 });
        out.push(mkRange(r.text, s, d, d2.plus({ days: 1 }), "range"));
      } else {
        out.push(
          mkDay(
            r.text,
            s,
            d,
            false,
            year === null && d.year !== today.year ? `no year given; assumed ${d.year}` : undefined,
          ),
        );
      }
      used.push({ s, e });
    } else {
      // Month-only matches need context: "in October", "since May", "October 2026" — not "march madness", "may I".
      const before = text.slice(0, s);
      const hasContext =
        year !== null ||
        /\b(in|during|since|from|throughout|early|mid|late|end of|start of|beginning of|last|this|of)\s+$/i.test(
          before,
        );
      if (!hasContext || !/^[A-Z]/.test(r.text.replace(/^\W*(in|on|during|since)\s+/i, "")))
        continue;
      let m0 = DateTime.fromObject({ year: year ?? today.year, month, day: 1 }, { zone: tz });
      if (!m0.isValid) continue;
      if (year === null && m0 > today) m0 = m0.minus({ years: 1 });
      const end = DateTime.min(m0.plus({ months: 1 }), tomorrow);
      out.push(mkRange(r.text, s, m0, end, "range"));
      used.push({ s, e });
    }
  }

  // --- "since X" turns a point into an open range up to now -------------------
  for (const r of out) {
    const before = text.slice(0, r.index);
    const m = before.match(/\b(since)\s+(?:the\s+)?$/i);
    if (!m) continue;
    const startDt = DateTime.fromISO(r.start, { zone: "utc" }).setZone(tz);
    r.phrase = `${m[1]} ${r.phrase}`.replace(/\s+/g, " ");
    r.index = r.index - m[0].length;
    r.end = iso(tomorrow);
    r.granularity = "range";
    r.label = `since ${dayLabel(startDt)}`;
    if (r.candidates) {
      r.candidates = r.candidates.map((c) => ({
        ...c,
        end: iso(tomorrow),
        label: `since ${c.label}`,
      }));
    }
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

const RECALL_VERB =
  /\b(ask(?:ed)?|said|say|told|tell|discuss(?:ed)?|talk(?:ed)?|mention(?:ed)?|chat(?:ted)?|conversation|shortlist(?:ed)?|recommend(?:ed)?|compar(?:ed|e)|look(?:ed)? (?:at|up)|search(?:ed)?)\b/i;

/**
 * Which resolved dates point back at past conversations (memory anchors)?
 * - "since X" anchors on the day X (that's when the baseline conversation happened).
 * - Past days/ranges are anchors.
 * - Ranges touching today ("today", "this week") are anchors only when a recall verb is near the phrase:
 *   "what did I ask you earlier today?" is; "is your answer still correct today?" is not.
 */
export function memoryAnchors(
  dates: ResolvedDate[],
  text: string,
  now: Date,
  tz: string,
): ResolvedDate[] {
  const today = DateTime.fromJSDate(now).setZone(tz).startOf("day");
  const out: ResolvedDate[] = [];
  for (const d of dates) {
    let a = d;
    if (d.phrase.toLowerCase().startsWith("since ")) {
      const s = DateTime.fromISO(d.start).setZone(tz);
      a = {
        ...d,
        end: iso(s.plus({ days: 1 }).startOf("day")),
        granularity: "day",
        label: dayLabel(s),
        candidates: d.candidates?.map((c) => ({
          ...c,
          end: iso(DateTime.fromISO(c.start).setZone(tz).plus({ days: 1 }).startOf("day")),
          label: c.label.replace(/^since /, ""),
        })),
      };
    }
    const touchesToday = DateTime.fromISO(a.end).setZone(tz) > today;
    if (!touchesToday) {
      out.push(a);
      continue;
    }
    const near = text.slice(Math.max(0, d.index - 40), d.index + d.phrase.length + 40);
    if (RECALL_VERB.test(near)) out.push(a);
  }
  return out;
}

function maskSpans(text: string, spans: Span[]): string {
  const chars = text.split("");
  for (const sp of spans) for (let i = sp.s; i < sp.e; i++) chars[i] = " ";
  return chars.join("");
}

/** Compact rendering for prompts. */
export function renderResolvedDates(dates: ResolvedDate[]): string {
  if (dates.length === 0) return "(no relative or explicit dates in the message)";
  return dates
    .map((d) => {
      const base = `- "${d.phrase}" → ${d.label} [${d.start} .. ${d.end})${d.ambiguous ? " (AMBIGUOUS)" : ""}`;
      const alts =
        d.candidates && d.candidates.length > 1
          ? `\n    alternatives: ${d.candidates.map((c) => `${c.label} (${c.reading})`).join(" | ")}`
          : "";
      const note = d.note ? `\n    note: ${d.note}` : "";
      return base + alts + note;
    })
    .join("\n");
}

import { describe, expect, it } from "vitest";
import { resolveDates } from "../src/pipeline/temporal.js";
import { DateTime } from "luxon";

const IST = "Asia/Kolkata";
const LA = "America/Los_Angeles";
// Tue 10 Nov 2026, 22:22 IST
const NOW_IST = new Date("2026-11-10T16:52:00Z");

/** local YYYY-MM-DD of the start of a resolved range */
const localStart = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toISODate();
const one = (text: string, now = NOW_IST, tz = IST) => {
  const r = resolveDates(text, now, tz);
  expect(r.length, `expected exactly one date in "${text}", got ${JSON.stringify(r)}`).toBe(1);
  return r[0]!;
};

describe("temporal resolver", () => {
  it("bare weekday → most recent strictly before today", () => {
    const r = one("On Monday we shortlisted 5 CRM tools");
    expect(localStart(r.start, IST)).toBe("2026-11-09");
    expect(r.granularity).toBe("day");
    expect(r.ambiguous).toBe(false);
    expect(r.label).toBe("Mon 9 Nov 2026");
  });

  it("day ranges are local-day boundaries expressed in UTC", () => {
    const r = one("Monday");
    expect(r.start).toBe("2026-11-08T18:30:00Z");
    expect(r.end).toBe("2026-11-09T18:30:00Z");
  });

  it("bare weekday equal to today → last week's, ambiguous with today as candidate", () => {
    const r = one("what did we discuss on Tuesday?");
    expect(localStart(r.start, IST)).toBe("2026-11-03");
    expect(r.ambiguous).toBe(true);
    expect(r.candidates?.map((c) => localStart(c.start, IST))).toEqual([
      "2026-11-03",
      "2026-11-10",
    ]);
  });

  it("'last Tuesday' on a Tuesday = previous calendar week, unambiguous", () => {
    const r = one("Last Tuesday I asked you about Postgres hosting");
    expect(localStart(r.start, IST)).toBe("2026-11-03");
    expect(r.ambiguous).toBe(false);
  });

  it("'last Tuesday' on a Wednesday is ambiguous and exposes both readings", () => {
    const wed = new Date("2026-11-11T06:00:00Z"); // Wed 11 Nov IST
    const r = one("last Tuesday", wed);
    expect(localStart(r.start, IST)).toBe("2026-11-03"); // previous calendar week
    expect(r.ambiguous).toBe(true);
    expect(r.candidates?.map((c) => localStart(c.start, IST))).toEqual([
      "2026-11-03",
      "2026-11-10",
    ]);
  });

  it("explicit day+month without year → most recent past occurrence", () => {
    const r = one("What did I ask you on 3 November?");
    expect(localStart(r.start, IST)).toBe("2026-11-03");
    expect(r.ambiguous).toBe(false);
  });

  it("explicit date later in the year than today → previous year", () => {
    const r = one("what did I ask on 25 December?");
    expect(localStart(r.start, IST)).toBe("2025-12-25");
  });

  it("explicit date with year is kept as is", () => {
    expect(localStart(one("on 3 Nov 2025").start, IST)).toBe("2025-11-03");
    expect(localStart(one("on 2026-10-01").start, IST)).toBe("2026-10-01");
  });

  it("yesterday / today / day before yesterday", () => {
    expect(localStart(one("yesterday").start, IST)).toBe("2026-11-09");
    expect(localStart(one("earlier today").start, IST)).toBe("2026-11-10");
    expect(localStart(one("the day before yesterday").start, IST)).toBe("2026-11-08");
  });

  it("this week / last week are Mon–Sun ranges", () => {
    const tw = one("this week");
    expect(tw.granularity).toBe("week");
    expect(localStart(tw.start, IST)).toBe("2026-11-09");
    expect(localStart(tw.end, IST)).toBe("2026-11-11"); // through end of today
    const lw = one("last week");
    expect(localStart(lw.start, IST)).toBe("2026-11-02");
    expect(localStart(lw.end, IST)).toBe("2026-11-09");
    expect(lw.label).toBe("Mon 2 Nov – Sun 8 Nov 2026");
  });

  it("'since Monday' is an open range from Monday to now", () => {
    const r = one("anything new since Monday?");
    expect(r.phrase.toLowerCase()).toBe("since monday");
    expect(r.granularity).toBe("range");
    expect(localStart(r.start, IST)).toBe("2026-11-09");
    expect(localStart(r.end, IST)).toBe("2026-11-11");
    expect(r.label).toBe("since Mon 9 Nov 2026");
  });

  it("'a few days ago' → 3 days ago, ambiguous", () => {
    const r = one("a few days ago you told me something");
    expect(localStart(r.start, IST)).toBe("2026-11-07");
    expect(r.ambiguous).toBe(true);
  });

  it("'N days ago' and 'a week ago'", () => {
    expect(localStart(one("2 days ago").start, IST)).toBe("2026-11-08");
    const w = one("a week ago");
    expect(localStart(w.start, IST)).toBe("2026-11-03");
    expect(w.ambiguous).toBe(true);
  });

  it("day boundary: 00:30 IST Wed is still Tue in UTC — 'yesterday' must be Tue (IST)", () => {
    const now = new Date("2026-11-10T19:00:00Z"); // Wed 11 Nov 00:30 IST
    const r = one("yesterday", now, IST);
    expect(localStart(r.start, IST)).toBe("2026-11-10");
    expect(r.start).toBe("2026-11-09T18:30:00Z");
  });

  it("day boundary: 22:30 IST and the UTC date agree on 'today'", () => {
    const now = new Date("2026-11-10T17:00:00Z"); // 22:30 IST
    expect(localStart(one("today", now, IST).start, IST)).toBe("2026-11-10");
  });

  it("Los Angeles: 21:00 Mon local is Tue in UTC — 'yesterday' = Sun", () => {
    const now = new Date("2026-11-10T05:00:00Z"); // Mon 9 Nov 21:00 PST
    const r = one("yesterday", now, LA);
    expect(localStart(r.start, LA)).toBe("2026-11-08");
    expect(r.start).toBe("2026-11-08T08:00:00Z");
  });

  it("Los Angeles: bare 'Monday' on a Monday evening → previous Monday, ambiguous", () => {
    const now = new Date("2026-11-10T05:00:00Z"); // Mon 9 Nov PST
    const r = one("Monday", now, LA);
    expect(localStart(r.start, LA)).toBe("2026-11-02");
    expect(r.ambiguous).toBe(true);
  });

  it("DST end day (1 Nov 2026 in LA) is a 25-hour local day", () => {
    const now = new Date("2026-11-03T18:00:00Z");
    const r = one("on 1 November", now, LA);
    const hours = (Date.parse(r.end) - Date.parse(r.start)) / 3_600_000;
    expect(hours).toBe(25);
  });

  it("multiple phrases are returned in order of appearance", () => {
    const r = resolveDates(
      "What did I ask you on 3 November, and did anything change since Monday?",
      NOW_IST,
      IST,
    );
    expect(r.map((x) => x.label)).toEqual(["Tue 3 Nov 2026", "since Mon 9 Nov 2026"]);
  });

  it("does not hallucinate dates from numbers that are not dates", () => {
    expect(resolveDates("We have a 20-person sales team and 5 CRM tools", NOW_IST, IST)).toEqual(
      [],
    );
    expect(resolveDates("thanks!", NOW_IST, IST)).toEqual([]);
  });

  it("month only → month range, previous year if in the future", () => {
    const r = one("what did we talk about in October?");
    expect(localStart(r.start, IST)).toBe("2026-10-01");
    expect(localStart(r.end, IST)).toBe("2026-11-01");
    const dec = one("in December");
    expect(localStart(dec.start, IST)).toBe("2025-12-01");
  });
});

import { memoryAnchors } from "../src/pipeline/temporal.js";
describe("memoryAnchors", () => {
  const anchors = (text: string) =>
    memoryAnchors(resolveDates(text, NOW_IST, IST), text, NOW_IST, IST).map((d) => d.label);
  it("'still correct today' is not a memory anchor; the past date is", () => {
    expect(
      anchors("What did I ask you on 3 November? Is your answer still correct today?"),
    ).toEqual(["Tue 3 Nov 2026"]);
  });
  it("'what did I ask you earlier today' IS an anchor", () => {
    expect(anchors("what did I ask you earlier today?")).toEqual(["Tue 10 Nov 2026"]);
  });
  it("'since Monday' anchors on Monday itself", () => {
    expect(anchors("has anything changed since Monday?")).toEqual(["Mon 9 Nov 2026"]);
  });
});

describe("false positives", () => {
  it("product names and named events are not dates", () => {
    expect(resolveDates("Compare Monday.com and Asana pricing", NOW_IST, IST)).toEqual([]);
    expect(resolveDates("best Black Friday CRM deals", NOW_IST, IST)).toEqual([]);
  });
  it("lowercase month words without context are not dates", () => {
    expect(resolveDates("march madness tickets", NOW_IST, IST)).toEqual([]);
    expect(resolveDates("May I ask what you said?", NOW_IST, IST)).toEqual([]);
    expect(one("what did we discuss in October?").label).toBe("Thu 1 Oct – Sat 31 Oct 2026");
  });
});

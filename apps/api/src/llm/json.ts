import type { z } from "zod";
import { stripThink } from "./strip.js";

/**
 * Tolerant JSON extraction for model output:
 * strip <think>, strip ``` fences, find the first balanced {...}, remove trailing commas,
 * and (if truncated) close open strings/brackets as a best effort.
 */
export function extractJson(raw: string): unknown {
  let s = stripThink(raw).trim();
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence?.[1]) s = fence[1].trim();
  else s = s.replace(/^```(?:json)?/i, "").trim();

  const start = s.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in model output");
  const candidate = balancedSlice(s, start);
  const cleaned = removeTrailingCommas(candidate);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
}

/** Returns the balanced object starting at `start`, or a repaired version if truncated. */
function balancedSlice(s: string, start: number): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 0) return s.slice(start, i + 1);
    }
  }
  // Truncated: close what is open.
  let out = s.slice(start);
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
  while (stack.length) out += stack.pop();
  return out;
}

function removeTrailingCommas(s: string): string {
  // Remove commas before } or ] that are outside of strings.
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      const rest = s.slice(i + 1);
      if (/^\s*[}\]]/.test(rest)) continue;
    }
    out += c;
  }
  return out;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseWithSchema<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  let obj: unknown;
  try {
    obj = extractJson(raw);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const r = schema.safeParse(obj);
  if (r.success) return { ok: true, value: r.data };
  const msg = r.error.issues
    .slice(0, 6)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: msg };
}

/**
 * Parse → on failure, ask once for a repair (caller supplies the LLM call) → else null.
 * Exactly one repair retry, by design: a second one rarely helps with free models and costs ~2-4 s.
 */
export async function parseWithRepair<T>(
  raw: string,
  schema: z.ZodType<T>,
  repair: (error: string, previous: string) => Promise<string>,
): Promise<{ value: T | null; repaired: boolean; error?: string }> {
  const first = parseWithSchema(raw, schema);
  if (first.ok) return { value: first.value, repaired: false };
  let second: ParseResult<T>;
  try {
    const fixed = await repair(first.error, raw);
    second = parseWithSchema(fixed, schema);
  } catch (e) {
    return { value: null, repaired: true, error: (e as Error).message };
  }
  if (second.ok) return { value: second.value, repaired: true };
  return { value: null, repaired: true, error: second.error };
}

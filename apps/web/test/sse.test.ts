import { describe, expect, it } from "vitest";
import { SseParser, consumeSse } from "../lib/sse";

describe("SseParser", () => {
  it("parses complete frames and ignores comments", () => {
    const p = new SseParser();
    const ev = p.push(': open\n\ndata: {"type":"token","text":"Hi"}\n\n: ping\n\n');
    expect(ev).toEqual([{ type: "token", text: "Hi" }]);
  });

  it("handles frames split across chunks (even mid-JSON) and CRLF", () => {
    const p = new SseParser();
    expect(p.push('data: {"type":"tok')).toEqual([]);
    expect(p.push('en","text":"a"}\r\n\r\ndata: {"type":"token","text":"b"}')).toEqual([
      { type: "token", text: "a" },
    ]);
    expect(p.push("\n\n")).toEqual([{ type: "token", text: "b" }]);
  });

  it("skips malformed and type-less frames", () => {
    const p = new SseParser();
    expect(
      p.push(
        'data: {nope\n\ndata: {"x":1}\n\ndata: {"type":"status","stage":"plan","text":"t"}\n\n',
      ),
    ).toEqual([{ type: "status", stage: "plan", text: "t" }]);
  });

  it("consumeSse reads a streamed Response", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"type":"token","text":"x"}\n\ndata: {"type":"do'));
        c.enqueue(
          enc.encode(
            'ne","messageId":null,"timings":{"memory_ms":1,"plan_ms":2,"search_ms":3,"ttft_ms":4,"total_ms":5},"models":[],"searchCalls":0}\n\n',
          ),
        );
        c.close();
      },
    });
    const seen: string[] = [];
    await consumeSse(new Response(body), (e) => seen.push(e.type));
    expect(seen).toEqual(["token", "done"]);
  });
});

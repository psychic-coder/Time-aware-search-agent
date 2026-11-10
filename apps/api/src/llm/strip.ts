/**
 * Reasoning-model hygiene. Some DeepSeek variants (R1 family, hybrid V3.1) emit
 * <think>…</think> in the content channel. Nothing inside it may reach the user.
 */

export function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Unclosed <think> (truncated output): drop everything after it.
  const open = out.search(/<think>/i);
  if (open !== -1) out = out.slice(0, open);
  // Orphan closing tag (model started mid-thought): drop everything before it.
  const close = out.search(/<\/think>/i);
  if (close !== -1) out = out.slice(close + "</think>".length);
  return out;
}

/**
 * Streaming version: tags may be split across chunks ("<thi" + "nk>").
 * Holds back a small tail that could be the start of a tag.
 */
export class ThinkStripper {
  private buf = "";
  private inThink = false;
  private sawContent = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inThink) {
        const end = this.buf.search(/<\/think>/i);
        if (end === -1) {
          // keep only a possible partial closing tag
          this.buf = this.buf.slice(Math.max(0, this.buf.length - 7));
          return this.emit(out);
        }
        this.buf = this.buf.slice(end + 8);
        this.inThink = false;
        continue;
      }
      const start = this.buf.search(/<think>/i);
      const orphanClose = !this.sawContent ? this.buf.search(/<\/think>/i) : -1;
      if (orphanClose !== -1 && (start === -1 || orphanClose < start)) {
        // Content so far was reasoning without an opening tag.
        this.buf = this.buf.slice(orphanClose + 8);
        out = "";
        continue;
      }
      if (start !== -1) {
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inThink = true;
        continue;
      }
      // Hold back a tail that might be the beginning of "<think>" or "</think>".
      const lt = this.buf.lastIndexOf("<");
      if (lt !== -1 && this.buf.length - lt < 8 && /^<\/?t?h?i?n?k?$/i.test(this.buf.slice(lt))) {
        out += this.buf.slice(0, lt);
        this.buf = this.buf.slice(lt);
      } else {
        out += this.buf;
        this.buf = "";
      }
      return this.emit(out);
    }
  }

  flush(): string {
    if (this.inThink) {
      this.buf = "";
      return "";
    }
    const rest = this.buf;
    this.buf = "";
    return this.emit(rest);
  }

  private emit(s: string): string {
    // Trim leading whitespace left behind after a removed think block.
    if (!this.sawContent) {
      s = s.replace(/^\s+/, "");
      if (s.length > 0) this.sawContent = true;
    }
    return s;
  }
}

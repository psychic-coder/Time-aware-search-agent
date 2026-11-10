import { Router } from "express";
import type { MemoryStore, StoredSource } from "../pipeline/memory.js";
import { clientIdOf, UUID_RE } from "./chat.js";

export function conversationsRouter(memory: MemoryStore): Router {
  const r = Router();

  r.use("/api/conversations", (req, res, next) => {
    if (!clientIdOf(req))
      return res
        .status(400)
        .json({ error: "Missing or invalid X-Client-Id header (expected a UUID)." });
    next();
  });

  r.get("/api/conversations", (req, res) => {
    const clientId = clientIdOf(req) as string;
    res.json({
      conversations: memory.listConversations(clientId).map((c) => ({
        id: c.id,
        title: c.title,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    });
  });

  r.get("/api/conversations/:id", (req, res) => {
    const clientId = clientIdOf(req) as string;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const conv = memory.getConversation(clientId, req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found." });
    const messages = memory.getMessages(clientId, conv.id).map((m) => {
      let sources: StoredSource[] = [];
      let intent: string | null = null;
      try {
        sources = m.sources_json ? (JSON.parse(m.sources_json) as StoredSource[]) : [];
        intent = m.plan_json
          ? ((JSON.parse(m.plan_json) as { intent?: string }).intent ?? null)
          : null;
      } catch {
        /* tolerate legacy rows */
      }
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.created_at_utc,
        sources,
        intent,
      };
    });
    res.json({
      conversation: {
        id: conv.id,
        title: conv.title,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
      },
      messages,
    });
  });

  r.delete("/api/conversations/:id", (req, res) => {
    const clientId = clientIdOf(req) as string;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const ok = memory.deleteConversation(clientId, req.params.id);
    if (!ok) return res.status(404).json({ error: "Conversation not found." });
    res.status(204).end();
  });

  return r;
}

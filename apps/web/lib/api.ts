import { consumeSse, type ServerEvent, type SourceRef } from "./sse";
import { getTimeZone } from "./clientId";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(
  /\/$/,
  "",
);

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  sources: (SourceRef & { retrieved_at?: string })[];
  intent: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function headers(clientId: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Client-Id": clientId,
    "X-Timezone": getTimeZone(),
  };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status >= 500 || res.status === 429);
  }
  return (await res.json()) as T;
}

const unreachable = () =>
  new ApiError(`Can't reach the API at ${API_URL}. Is the server running (npm run dev)?`, true);

export async function listConversations(clientId: string): Promise<ConversationSummary[]> {
  try {
    const res = await fetch(`${API_URL}/api/conversations`, { headers: headers(clientId) });
    return (await json<{ conversations: ConversationSummary[] }>(res)).conversations;
  } catch (e) {
    throw e instanceof ApiError ? e : unreachable();
  }
}

export async function getConversation(
  clientId: string,
  id: string,
): Promise<{ conversation: ConversationSummary; messages: StoredMessage[] }> {
  const res = await fetch(`${API_URL}/api/conversations/${id}`, { headers: headers(clientId) });
  return json(res);
}

export async function deleteConversation(clientId: string, id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/conversations/${id}`, {
    method: "DELETE",
    headers: headers(clientId),
  });
  if (!res.ok && res.status !== 404) throw new ApiError("Couldn't delete the conversation.", true);
}

export async function streamChat(
  clientId: string,
  body: { conversationId: string | null; message: string },
  onEvent: (e: ServerEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/chat`, {
      method: "POST",
      headers: headers(clientId),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw unreachable();
  }
  if (!res.ok) await json(res); // throws ApiError with the server's friendly message
  try {
    await consumeSse(res, onEvent);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("The connection dropped before the answer finished.", true);
  }
}

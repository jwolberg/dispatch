import { api } from "./client.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface Ticket {
  title: string;
  body_markdown: string;
  labels: string[];
}

export interface StreamHandlers {
  onChatId?: (id: number) => void;
  onDelta: (text: string) => void;
  /** The model is reading a repo file mid-turn (#27) — render "reading <path>". */
  onTool?: (tool: string, path?: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

// POST /api/chat returns an SSE-style stream; we read the body and parse the
// `data: {...}` frames (EventSource can't POST, so we read the ReadableStream).
export async function streamChat(
  body: { repo_id: number; chat_id?: number; message: string },
  h: StreamHandlers
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    h.onError((data && data.error) || res.statusText);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let data: any;
      try {
        data = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (data.type === "chat") h.onChatId?.(data.chat_id);
      else if (data.type === "delta") h.onDelta(data.text);
      else if (data.type === "tool") h.onTool?.(data.tool, data.path);
      else if (data.type === "done") h.onDone();
      else if (data.type === "error") h.onError(data.message);
    }
  }
}

export const chatApi = {
  generateTicket: (chatId: number) =>
    api.post<{ ticket: Ticket }>(`/chat/${chatId}/generate-ticket`),
};

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Page } from "../components/Page.js";
import { reposApi } from "../api/repos.js";
import { streamChat, chatApi, type ChatTurn, type Ticket } from "../api/chat.js";
import { ApiError } from "../api/client.js";
import type { TrackedRepo } from "../api/types.js";
import { TicketPreviewModal } from "../components/TicketPreviewModal.js";

export function ChatPage() {
  const [searchParams] = useSearchParams();
  const resumeChatId = searchParams.get("chatId");
  const [repos, setRepos] = useState<TrackedRepo[]>([]);
  const [repoId, setRepoId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [chatId, setChatId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<Ticket | null>(null);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    reposApi
      .list()
      .then(async ({ repos }) => {
        if (cancelled) return;
        setRepos(repos);

        // Board "resume draft" link: hydrate the prior transcript instead of
        // starting a blank session. A stale/deleted id (404) falls back to a
        // fresh chat with no error shown — the link just no longer resolves.
        if (resumeChatId) {
          try {
            const chat = await chatApi.get(Number(resumeChatId));
            if (cancelled) return;
            setChatId(chat.id);
            setRepoId(chat.repo_id);
            setMessages(chat.transcript);
            return;
          } catch {
            // fall through to a blank new chat
          }
        }

        if (repos.length) setRepoId(repos[0].id);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Switching repos starts a fresh chat.
  function selectRepo(id: number) {
    setRepoId(id);
    setMessages([]);
    setChatId(null);
    setDraft(null);
    setError(null);
  }

  async function send() {
    if (!input.trim() || streaming || repoId == null) return;
    const text = input.trim();
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setStreaming(true);

    await streamChat(
      { repo_id: repoId, chat_id: chatId ?? undefined, message: text },
      {
        onChatId: (id) => setChatId(id),
        onDelta: (delta) => {
          setToolStatus(null); // text is flowing again — clear "reading …"
          setMessages((m) => {
            const next = [...m];
            next[next.length - 1] = {
              role: "assistant",
              content: next[next.length - 1].content + delta,
            };
            return next;
          });
        },
        onTool: (tool, path) => setToolStatus(path ? `reading ${path}…` : `${tool}…`),
        onDone: () => {
          setStreaming(false);
          setToolStatus(null);
        },
        onError: (msg) => {
          setStreaming(false);
          setToolStatus(null);
          setError(msg);
          setInput(text); // S4: never lose the user's typed message
          setMessages((m) => m.slice(0, -2)); // drop the optimistic user+assistant pair
        },
      }
    );
  }

  async function generate() {
    if (chatId == null) return;
    setGenerating(true);
    setError(null);
    try {
      const { ticket } = await chatApi.generateTicket(chatId);
      setDraft(ticket);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  const canGenerate = chatId != null && !streaming && messages.some((m) => m.role === "assistant" && m.content);

  return (
    <Page title="Spec chat">
      {repos.length === 0 ? (
        <p className="text-body text-gray-500">Track a repo first to start a spec chat.</p>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            <select
              className="rounded border border-border bg-surface px-2 py-1.5 text-body text-gray-200"
              value={repoId ?? ""}
              onChange={(e) => selectRepo(Number(e.target.value))}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.provider}:{r.path}
                </option>
              ))}
            </select>
            <button
              className="ml-auto rounded bg-blue-600 px-3 py-1.5 text-body font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              disabled={!canGenerate || generating}
              onClick={generate}
            >
              {generating ? "Generating…" : "Generate ticket"}
            </button>
          </div>

          {error && (
            <div className="mb-3 rounded border border-status-fail/40 bg-status-fail/10 px-3 py-2 text-body text-status-fail">
              {error}
            </div>
          )}

          <div className="mb-3 h-[55vh] overflow-y-auto rounded-lg border border-border bg-surface p-4">
            {messages.length === 0 ? (
              <p className="text-body text-gray-500">
                Describe the feature or bug. I’ll help shape it into an issue spec.
              </p>
            ) : (
              messages.map((m, i) => (
                <div key={i} className="mb-3">
                  <div className="mb-0.5 text-label uppercase tracking-wide text-gray-500">
                    {m.role}
                  </div>
                  <div className="whitespace-pre-wrap text-body text-gray-100">
                    {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
                  </div>
                  {toolStatus && streaming && i === messages.length - 1 && (
                    <div className="mt-1 font-mono text-label text-gray-500">↳ {toolStatus}</div>
                  )}
                </div>
              ))
            )}
            <div ref={endRef} />
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              className="flex-1 rounded border border-border bg-surface px-3 py-2 text-body text-gray-100 placeholder:text-gray-500"
              placeholder="Describe the change…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={streaming}
            />
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-2 text-body font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              disabled={streaming || !input.trim()}
            >
              Send
            </button>
          </form>
        </>
      )}

      <TicketPreviewModal
        open={draft != null}
        ticket={draft}
        chatId={chatId}
        repoId={repoId}
        onClose={() => setDraft(null)}
      />
    </Page>
  );
}

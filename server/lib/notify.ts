// Optional Slack notifications via an Incoming Webhook (one-way, no OAuth).
// Active only when SLACK_WEBHOOK_URL is set — otherwise a no-op, like the basic-
// auth gate. Fire-and-forget: a Slack outage must never block an activity write,
// so this is sync, never throws, and is best-effort.

import { safeMessage } from "./redaction.js";

export interface NotifyEvent {
  type: string;
  summary: string;
  url?: string | null;
}

function emojiFor(type: string): string {
  if (type.startsWith("column:")) {
    switch (type.slice("column:".length)) {
      case "Ready to test":
        return "🧪";
      case "Blocked":
        return "⛔";
      case "Building":
        return "🔨";
      case "Merged":
        return "🔀";
      case "Deployed":
        return "🚀";
      case "Queued":
        return "📋";
      default:
        return "🔵";
    }
  }
  if (type === "issue_created") return "📝";
  if (type === "pr_opened") return "🔀";
  if (type === "merged") return "🚀";
  if (type === "steer") return "🧭";
  if (type.startsWith("skill:")) return "🤖";
  return "•";
}

/** Best-effort Slack notification for an activity event (no-op if unconfigured). */
export function notifySlack(event: NotifyEvent): void {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  const link = event.url ? ` <${event.url}|view>` : "";
  const text = `${emojiFor(event.type)} ${event.summary}${link}`;
  void fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
    .then((res) => {
      if (!res.ok) console.warn(`[notify] Slack responded ${res.status}`);
    })
    .catch((err) => {
      console.warn(`[notify] Slack post failed: ${safeMessage(err)}`);
    });
}

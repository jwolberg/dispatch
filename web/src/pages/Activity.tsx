import { Link } from "react-router-dom";
import { Page } from "../components/Page.js";
import { usePolling } from "../hooks/usePolling.js";
import { activityApi } from "../api/activity.js";

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString();
}

export function ActivityPage() {
  const { data, error } = usePolling(() => activityApi.get(), 15_000);
  const events = data?.events ?? [];

  return (
    <Page title="Activity">
      {error && (
        <div className="mb-3 rounded border border-status-fail/40 bg-status-fail/10 px-3 py-2 text-body text-status-fail">
          {error}
        </div>
      )}
      {events.length === 0 ? (
        <p className="text-body text-gray-500">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {events.map((e) => (
            <li key={e.id} className="flex items-center gap-3 bg-surface px-3 py-2">
              <span className="w-20 shrink-0 text-label text-gray-500">{ago(e.occurred_at)}</span>
              <span className="flex-1 text-body text-gray-200">{e.summary}</span>
              {e.ticket_id != null && (
                <Link className="text-label text-status-info underline" to={`/tickets/${e.ticket_id}`}>
                  view
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

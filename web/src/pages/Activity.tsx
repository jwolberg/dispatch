import { Link } from "react-router-dom";
import { Page } from "../components/Page.js";
import { usePolling } from "../hooks/usePolling.js";
import { activityApi, type ActivityEvent } from "../api/activity.js";

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString();
}

interface TaskGroup {
  key: string;
  label: string;
  events: ActivityEvent[];
}

interface RepoGroup {
  key: string;
  label: string;
  tasks: TaskGroup[];
}

// Group events by repo, then subgroup by task (ticket). Events arrive sorted
// newest-first, and Map preserves insertion order, so groups stay ordered by
// most-recent activity.
function groupEvents(events: ActivityEvent[]): RepoGroup[] {
  const repos = new Map<string, Map<string, TaskGroup>>();
  const repoLabels = new Map<string, string>();

  for (const e of events) {
    const repoKey = e.repo_path ?? "__none__";
    repoLabels.set(repoKey, e.repo_path ?? "Unassigned");
    if (!repos.has(repoKey)) repos.set(repoKey, new Map());
    const tasks = repos.get(repoKey)!;

    const taskKey = e.ticket_id != null ? `t${e.ticket_id}` : "__none__";
    if (!tasks.has(taskKey)) {
      const label =
        e.ticket_id != null
          ? `#${e.issue_number ?? e.ticket_id}${e.task_title ? ` · ${e.task_title}` : ""}`
          : "General";
      tasks.set(taskKey, { key: taskKey, label, events: [] });
    }
    tasks.get(taskKey)!.events.push(e);
  }

  return [...repos.entries()].map(([repoKey, tasks]) => ({
    key: repoKey,
    label: repoLabels.get(repoKey)!,
    tasks: [...tasks.values()],
  }));
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
        <div className="flex flex-col gap-6">
          {groupEvents(events).map((repo) => (
            <section key={repo.key}>
              <h2 className="mb-2 text-label font-semibold uppercase tracking-wide text-gray-400">
                {repo.label}
              </h2>
              <div className="flex flex-col gap-3">
                {repo.tasks.map((task) => (
                  <div key={task.key} className="overflow-hidden rounded-lg border border-border">
                    <div className="border-b border-border bg-surface-2 px-3 py-1.5 text-label text-gray-300">
                      {task.label}
                    </div>
                    <ul className="divide-y divide-border">
                      {task.events.map((e) => (
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
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}

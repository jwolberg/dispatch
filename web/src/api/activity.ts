import { api } from "./client.js";

export interface ActivityEvent {
  id: number;
  ticket_id: number | null;
  type: string;
  summary: string;
  url: string | null;
  occurred_at: string;
  repo_path: string | null;
  issue_number: number | null;
  task_title: string | null;
}

export const activityApi = {
  get: () => api.get<{ events: ActivityEvent[] }>("/activity"),
};

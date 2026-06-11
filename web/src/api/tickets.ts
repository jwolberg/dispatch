import { api } from "./client.js";

export interface FiledTicket {
  id: number;
  issue_number: number;
  url: string;
}

export const ticketsApi = {
  file: (body: {
    repo_id: number;
    chat_id: number | null;
    title: string;
    body_markdown: string;
    labels: string[];
  }) => api.post<{ ticket: FiledTicket }>("/tickets", body),
};

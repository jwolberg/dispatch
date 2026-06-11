import { api } from "./client.js";

interface CardBase {
  column: string;
  repo: { id: number; path: string; provider: string; host: string | null };
}
export interface DraftCard extends CardBase {
  kind: "draft";
  id: number;
  title: string;
  created_at: string;
}
export interface TicketCard extends CardBase {
  kind: "ticket";
  id: number;
  issue_number: number;
  title: string;
  pr: { number: number; url: string } | null;
  has_progress: boolean;
  updated_at: string | null;
}
export type BoardCard = DraftCard | TicketCard;

export interface Board {
  columns: string[];
  cards: BoardCard[];
}

export const boardApi = {
  get: () => api.get<Board>("/board"),
};

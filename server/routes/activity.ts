import { Router } from "express";
import { recentActivity } from "../db/activity.js";

export const activityRouter = Router();

// GET /api/activity — most recent 50 events across all tickets (PRD F7),
// derived from polled data (no separate event store beyond the cache table).
activityRouter.get("/", (_req, res) => {
  res.json({ events: recentActivity(50) });
});

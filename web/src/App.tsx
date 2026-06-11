import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { HealthFooter } from "./components/HealthFooter.js";
import { RateLimitBanner } from "./components/RateLimitBanner.js";
import { usePolling } from "./hooks/usePolling.js";
import { api } from "./api/client.js";
import type { Health } from "./api/types.js";
import { ReposPage } from "./pages/Repos.js";
import { BoardPage } from "./pages/Board.js";
import { ChatPage } from "./pages/Chat.js";
import { CardDetailPage } from "./pages/CardDetail.js";
import { ActivityPage } from "./pages/Activity.js";

const NAV = [
  { to: "/board", label: "Board" },
  { to: "/repos", label: "Repos" },
  { to: "/chat", label: "Spec chat" },
  { to: "/activity", label: "Activity" },
];

export function App() {
  const { data: health } = usePolling(() => api.get<Health>("/health"), 30_000);
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center gap-6 border-b border-border bg-surface px-5 py-3">
        <span className="text-[15px] font-semibold tracking-tight text-white">Dispatch</span>
        <nav className="flex gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 text-body transition-colors ${
                  isActive
                    ? "bg-surface-2 text-white"
                    : "text-gray-300 hover:bg-surface-2 hover:text-white"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <RateLimitBanner health={health} />

      <main className="flex-1 px-5 py-5">
        <Routes>
          <Route path="/" element={<Navigate to="/board" replace />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/repos" element={<ReposPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/tickets/:id" element={<CardDetailPage />} />
          <Route path="/activity" element={<ActivityPage />} />
        </Routes>
      </main>

      <HealthFooter health={health} />
    </div>
  );
}

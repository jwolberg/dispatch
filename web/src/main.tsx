import React from "react";
import { createRoot } from "react-dom/client";

// Minimal placeholder shell. The real app shell, routing, and Tailwind dark
// theme arrive in P1-T8; this confirms the Vite dev server and /api proxy work.
function App() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, color: "#e5e7eb", background: "#0b0f17", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20 }}>Dispatch</h1>
      <p style={{ fontSize: 13 }}>Control plane scaffold is running.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

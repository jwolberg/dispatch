import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND_PORT = process.env.PORT ?? "3001";

// The browser only ever talks to the Vite dev origin; /api is proxied to the
// Express backend so credentials never reach the client.
export default defineConfig({
  root: "web",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
});

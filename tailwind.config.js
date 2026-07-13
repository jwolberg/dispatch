/** @type {import('tailwindcss').Config} */
export default {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#0b0f17",
        surface: "#131a26",
        "surface-2": "#1b2435",
        border: "#2a3650",
        gold: "#d4af37",
        // Status palette (PRD §4). Always paired with icon/text in components,
        // never color alone.
        status: {
          ok: "#22c55e",
          wait: "#f59e0b",
          fail: "#f87171",
          info: "#60a5fa",
        },
      },
      fontSize: {
        // PRD §4 readability floors.
        label: ["11.5px", { lineHeight: "1.4" }],
        body: ["13px", { lineHeight: "1.5" }],
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        void: "#05050a",
        panel: "#0b0d16",
        "panel-border": "#1c2130",
        ingestion: "#c026d3",
        diagnostic: "#f59e0b",
        cyanpulse: "#22d3ee",
        vault: "#10b981",
        salvage: "#34d399",
        terminal: "#ef4444",
        mist: "#9aa4c0",
      },
      fontFamily: {
        display: ["'Space Grotesk'", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px 2px rgba(34, 211, 238, 0.35)",
        "glow-emerald": "0 0 24px 2px rgba(16, 185, 129, 0.35)",
      },
    },
  },
  plugins: [],
};

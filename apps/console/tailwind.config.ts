import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#fafaf9",
        card: "#ffffff",
        ink: "#1c1917",
        muted: "#78716c",
        faint: "#a8a29e",
        line: "#e7e5e4",
        primary: {
          DEFAULT: "#2563eb",
          dark: "#1d4ed8",
          soft: "#eff6ff",
        },
        ok: "#15803d",
        okbg: "#f0fdf4",
        warn: "#b45309",
        warnbg: "#fffbeb",
        danger: "#dc2626",
        dangerbg: "#fef2f2",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter Tight", "Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        xl2: "12px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(28, 25, 23, 0.05)",
      },
    },
  },
  plugins: [],
};

export default config;

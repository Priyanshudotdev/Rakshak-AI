import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#12151a",
        surface: "#1a1f27",
        surface2: "#222833",
        surface3: "#2a3240",
        cream: "#e8e4dc",
        muted: "#9a9488",
        accent: "#c45c26",
        accentpress: "#a64c1e",
        accentlight: "#e0773d",
        line: "#2c3340",
        priohigh: "#d64545",
        priomed: "#d4a017",
        priolow: "#3d8b6e",
        infoblue: "#3b82f6",
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"Segoe UI"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', '"Cascadia Mono"', "Consolas", "monospace"],
      },
      borderRadius: { md2: "8px", lg2: "12px" },
    },
  },
  plugins: [],
};

export default config;

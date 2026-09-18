import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#f4f4f1",
        surface: "#ffffff",
        surface2: "#efefe9",
        surface3: "#e2e2d8",
        cream: "#1b1e22",
        muted: "#66707c",
        accent: "#c45c26",
        accentpress: "#a64c1e",
        accentlight: "#e0773d",
        line: "#e2e2d9",
        priohigh: "#c43434",
        priomed: "#8f6200",
        priolow: "#1e7a5c",
        infoblue: "#2456d6",
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

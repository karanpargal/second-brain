/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f7f7f8",
          100: "#eeeef0",
          200: "#d9d9de",
          300: "#b8b8c1",
          400: "#8e8e9a",
          500: "#6f6f7b",
          600: "#595963",
          700: "#494951",
          800: "#3f3f46",
          900: "#18181b",
          950: "#0c0c0e",
        },
        accent: {
          DEFAULT: "#818cf8",
          dim: "#6366f1",
          bright: "#a5b4fc",
        },
        good: "#34d399",
        warn: "#fbbf24",
        bad: "#f87171",
      },
      fontFamily: {
        sans: [
          "IBM Plex Sans",
          "ui-sans-serif",
          "system-ui",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["IBM Plex Mono", "ui-monospace", "Consolas", "monospace"],
      },
      boxShadow: {
        card: "0 0 0 1px rgba(255,255,255,0.06), 0 8px 24px rgba(0,0,0,0.35)",
      },
    },
  },
  plugins: [],
};

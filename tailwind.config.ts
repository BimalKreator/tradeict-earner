import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        glass: {
          dark: "rgba(15, 23, 42, 0.6)",
          border: "rgba(255, 255, 255, 0.08)",
          highlight: "rgba(255, 255, 255, 0.12)",
        },
        navy: {
          950: "#0a0f1a",
          900: "#0f172a",
          800: "#1e293b",
          700: "#1e3a5f",
          600: "#2563eb",
        },
      },
      backdropBlur: {
        glass: "12px",
        "glass-lg": "20px",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "dark-blue-shine": "linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)",
      },
    },
  },
  plugins: [],
};

export default config;

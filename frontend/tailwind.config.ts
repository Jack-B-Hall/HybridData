import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["'Fraunces'", "ui-serif", "Georgia", "serif"],
        sans: ["'Manrope'", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        canvas: {
          DEFAULT: "var(--color-canvas)",
          raised: "var(--color-canvas-raised)",
          sunken: "var(--color-canvas-sunken)",
          overlay: "var(--color-canvas-overlay)",
        },
        border: {
          DEFAULT: "var(--color-border)",
          strong: "var(--color-border-strong)",
        },
        ink: {
          DEFAULT: "var(--color-ink)",
          muted: "var(--color-ink-muted)",
          faint: "var(--color-ink-faint)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          strong: "var(--color-accent-strong)",
          soft: "var(--color-accent-soft)",
          ink: "var(--color-accent-ink)",
        },
        tier: {
          formal: "var(--color-tier-formal)",
          "formal-soft": "var(--color-tier-formal-soft)",
          unverified: "var(--color-tier-unverified)",
          "unverified-soft": "var(--color-tier-unverified-soft)",
          informal: "var(--color-tier-informal)",
          "informal-soft": "var(--color-tier-informal-soft)",
        },
        confidence: {
          high: "var(--color-confidence-high)",
          medium: "var(--color-confidence-medium)",
          low: "var(--color-confidence-low)",
        },
      },
      boxShadow: {
        panel: "0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 1px 0 rgb(0 0 0 / 0.03)",
        popover: "0 12px 32px -8px rgb(0 0 0 / 0.28), 0 4px 12px -4px rgb(0 0 0 / 0.16)",
      },
      borderRadius: {
        card: "10px",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.97) translateY(4px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.22s ease-out",
        "pop-in": "pop-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
} satisfies Config;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./client/index.html', './client/src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: 'rgb(var(--color-ink) / <alpha-value>)',
          soft: 'rgb(var(--color-ink-soft) / <alpha-value>)',
          faint: 'rgb(var(--color-ink-faint) / <alpha-value>)',
        },
        paper: 'rgb(var(--color-paper) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        line: {
          DEFAULT: 'rgb(var(--color-line) / <alpha-value>)',
          strong: 'rgb(var(--color-line-strong) / <alpha-value>)',
        },
        settled: {
          DEFAULT: 'rgb(var(--color-settled) / <alpha-value>)',
          deep: 'rgb(var(--color-settled-deep) / <alpha-value>)',
          tint: 'rgb(var(--color-settled-tint) / <alpha-value>)',
        },
        attention: {
          DEFAULT: 'rgb(var(--color-attention) / <alpha-value>)',
          deep: 'rgb(var(--color-attention-deep) / <alpha-value>)',
          tint: 'rgb(var(--color-attention-tint) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(24, 34, 51, 0.06)',
        raise: '0 6px 20px rgba(24, 34, 51, 0.10)',
      },
      borderRadius: { xl: '10px' },
    },
  },
  plugins: [],
};

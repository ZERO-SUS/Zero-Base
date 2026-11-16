import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--zb-bg)',
        surface: 'var(--zb-surface)',
        elevated: 'var(--zb-elevated)',
        sidebar: 'var(--zb-sidebar)',
        input: 'var(--zb-input)',
        text: {
          primary: 'var(--zb-text-primary)',
          secondary: 'var(--zb-text-secondary)',
          muted: 'var(--zb-text-muted)',
        },
        border: {
          DEFAULT: 'var(--zb-border)',
          strong: 'var(--zb-border-strong)',
        },
        accent: {
          DEFAULT: 'var(--zb-accent)',
          hover: 'var(--zb-accent-hover)',
          soft: 'var(--zb-accent-soft)',
          fg: 'var(--zb-accent-fg)',
        },
        focus: 'var(--zb-focus)',
        success: {
          DEFAULT: 'var(--zb-success)',
          soft: 'var(--zb-success-soft)',
        },
        warning: {
          DEFAULT: 'var(--zb-warning)',
          soft: 'var(--zb-warning-soft)',
        },
        error: {
          DEFAULT: 'var(--zb-error)',
          soft: 'var(--zb-error-soft)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        subtle: '0 1px 2px 0 rgb(0 0 0 / 0.04)',
        card: '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        modal: '0 16px 40px -8px rgb(0 0 0 / 0.22)',
      },
    },
  },
  plugins: [],
} satisfies Config;

import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0a0e14',
          900: '#0f1520',
          850: '#151c28',
          800: '#1c2532',
          700: '#2a3444',
          600: '#3b4759',
        },
        accent: {
          DEFAULT: '#4f9cf9',
          muted: '#2d6cbf',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;

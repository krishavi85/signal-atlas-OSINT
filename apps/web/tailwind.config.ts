import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // NOTE: 950/900/850/800/700/600 are load-bearing across every existing
        // screen — kept numerically identical, only lightly retuned toward a
        // cooler, slightly deeper navy so accent colors pop more. New steps
        // (975/750/720/650) fill in the ramp for the polish pass without
        // touching anything already in use.
        ink: {
          975: '#05070b',
          950: '#0a0d14',
          900: '#0e131c',
          850: '#131a26',
          800: '#1a2230',
          750: '#202a3a',
          720: '#26324540',
          700: '#2a3444',
          650: '#33405480',
          600: '#3d4b61',
        },
        accent: {
          DEFAULT: '#4f9cf9',
          bright: '#7db8ff',
          muted: '#2d6cbf',
          dim: '#1d3a5f',
        },
        signal: {
          cyan: '#22d3d0',
          violet: '#a78bfa',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.4), 0 0 0 1px rgb(255 255 255 / 0.02) inset',
        popover: '0 12px 32px -8px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(255 255 255 / 0.04) inset',
        glow: '0 0 0 1px rgb(79 156 249 / 0.4), 0 0 20px -4px rgb(79 156 249 / 0.35)',
      },
      backgroundImage: {
        'grid-fade':
          'radial-gradient(ellipse 80% 60% at 50% -20%, rgba(79,156,249,0.12), transparent), radial-gradient(ellipse 60% 40% at 100% 0%, rgba(34,211,208,0.07), transparent)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.18s ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;

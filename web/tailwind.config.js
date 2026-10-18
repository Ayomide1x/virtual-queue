/** @type {import('tailwindcss').Config} */
export default {
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Public Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        // Palette adapted from the U.S. Web Design System: calm, high-contrast.
        navy: { 950: '#0b1d33', 900: '#112f4e', 800: '#1a4480', 700: '#205493' },
        primary: { DEFAULT: '#005ea2', dark: '#1a4480', light: '#d9e8f6', lighter: '#eff6fb' },
        ink: '#1b1b1b',
        muted: { DEFAULT: '#565c65', light: '#a9aeb1', lighter: '#dfe1e2', lightest: '#f0f0f0' },
        success: { DEFAULT: '#00a91c', dark: '#008817', darker: '#216e1f', light: '#ecf3ec' },
        warning: { DEFAULT: '#ffbe2e', dark: '#936f38', light: '#faf3d1' },
        danger: { DEFAULT: '#d54309', dark: '#b50909', light: '#f4e3db' },
        focus: '#2491ff',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(0,169,28,0.55)' },
          '70%': { boxShadow: '0 0 0 24px rgba(0,169,28,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(0,169,28,0)' },
        },
        'fade-in': { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'none' } },
        highlight: { '0%': { backgroundColor: 'rgba(255,190,46,0.45)' }, '100%': { backgroundColor: 'transparent' } },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.8s ease-out infinite',
        'fade-in': 'fade-in 0.25s ease-out',
        highlight: 'highlight 4s ease-out',
      },
    },
  },
  plugins: [],
};

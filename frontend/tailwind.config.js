/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0f1117',
        surface: '#1a1d27',
        border: '#2a2d3a',
        text: '#e8eaf0',
        muted: '#6b7280',
        accent: '#7c5cbf',
        'accent-lo': '#3d2e6a',
        success: '#3d9970',
        warn: '#e07b39',
        danger: '#d64545',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

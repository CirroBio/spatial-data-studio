import studio from '../packages/studio-ui/tailwind.preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [studio],
  content: ['./index.html', './src/**/*.{ts,tsx}', '../packages/studio-ui/src/**/*.{ts,tsx}'],
  plugins: [],
};

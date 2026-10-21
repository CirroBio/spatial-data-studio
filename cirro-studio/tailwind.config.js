import studio from '../packages/studio-ui/tailwind.preset.js';

// Tailwind here styles only the Studio's shared controls (packages/studio-ui), so they
// look as they do in the Studio. The app's own pages use src/styles; preflight is off so
// Tailwind's reset leaves them alone, and src/styles/studio-ui.css applies the part of it
// the controls need to them alone.
/** @type {import('tailwindcss').Config} */
export default {
  presets: [studio],
  content: ['../packages/studio-ui/src/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  plugins: [],
};

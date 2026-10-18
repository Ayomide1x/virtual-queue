import { fileURLToPath } from 'node:url';

// Explicit config path, so building from another folder (e.g. the browser tests) works.
export default {
  plugins: { tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) }, autoprefixer: {} },
};

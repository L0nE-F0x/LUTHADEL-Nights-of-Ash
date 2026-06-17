import { defineConfig } from 'vite';

// The preview tooling launches this project from its Windows 8.3 short path
// (no spaces), which doesn't match Vite's realpath-based fs allow-list. Relaxing
// fs.strict only affects the dev server — production builds are unaffected.
export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
    fs: { strict: false },
  },
});

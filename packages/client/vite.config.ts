import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // .glb is not in Vite's built-in static-asset list, so importing
  // `./bag.glb` from baseManifest.ts needs an explicit assetsInclude entry
  // to be treated as a URL reference rather than parsed as JS.
  assetsInclude: ['**/*.glb'],
  // Satori reads `process.env.JEST` / `process.env.SATORI` at module-init
  // time. The browser has no `process` global, so dev mode threw
  // `ReferenceError: process is not defined` on first Rich UI render.
  // Replace the access at transform time with an empty object so unset
  // keys evaluate to `undefined` (matching Node behaviour).
  define: {
    'process.env': '{}',
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'node',
  },
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { serviceWorker } from './sw/plugin.ts';

// For working on the editor: run `quillipi serve` on port 4321 and open its login link once
// (the sign-in cookie also works here), then run `npm run dev:web`. Calls, files and the live
// connection are all under /api, so that one path goes through to it, WebSockets included.
const program = { target: 'http://localhost:4321', changeOrigin: true, headers: { origin: 'http://localhost:4321' }, ws: true };

export default defineConfig({
  // The service worker is built only with the app (`npm run build`), never under the dev server.
  plugins: [react(), tailwindcss(), serviceWorker()],
  // The editor is one bundle; the service worker keeps it on the device after the first visit.
  build: { chunkSizeWarningLimit: 2000 },
  server: { proxy: { '/api': program } },
});

// The chart's dev server and build (M2-05). REST and the live WebSocket are
// proxied to the platform, so the browser sees one origin (no CORS), as it
// will behind one host on staging (M2-01). AIA_PLATFORM_URL picks the
// platform (default http://127.0.0.1:8080, `pnpm platform`).

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const platform = process.env['AIA_PLATFORM_URL'] ?? 'http://127.0.0.1:8080';
const proxy = {
  '/bars': platform,
  '/instruments': platform,
  '/plan': platform,
  '/indicators': platform,
  '/auth': platform,
  '/live': { target: platform, ws: true },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});

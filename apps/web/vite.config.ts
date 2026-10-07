import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the browser calls /api on the same origin and Vite proxies it to the
// api container. In prod, nginx does the same proxying (see nginx/).
export default defineConfig({
  plugins: [react()],
  server: {
    // 'web' is the hostname the e2e container uses to reach this dev server.
    allowedHosts: ['web', 'localhost'],
    proxy: {
      '/api': process.env.VITE_API_PROXY ?? 'http://localhost:8080',
    },
  },
});

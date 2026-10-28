import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Keys are prefixes: the trailing slash keeps web modules such as
    // /api.ts on Vite instead of proxying them to the server.
    proxy: {
      '/api/': `http://127.0.0.1:${process.env.VOLVERAN_PORT ?? '8080'}`,
      // Team Mode sign-in; set VOLVERAN_OIDC_REDIRECT_URL to http://localhost:5173/auth/callback.
      '/auth/': `http://127.0.0.1:${process.env.VOLVERAN_PORT ?? '8080'}`,
    },
  },
});

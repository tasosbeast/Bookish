import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (mode === 'production' && !env.VITE_API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is required for production builds');
  }
  if (mode === 'production') {
    const apiUrl = new URL(env.VITE_API_BASE_URL);
    if (apiUrl.protocol !== 'https:' || apiUrl.search || apiUrl.hash || !apiUrl.pathname.replace(/\/+$/, '').endsWith('/api')) {
      throw new Error('VITE_API_BASE_URL must be an HTTPS URL ending in /api');
    }
  }
  return { plugins: [react(), tailwindcss()] };
});

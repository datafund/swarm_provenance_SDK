import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      // Allow viem's internal use of new Function() for ABI encoding
      'Content-Security-Policy': "script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src *;",
    },
  },
});

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync } from 'fs'
import { resolve } from 'path'

const backendUrl = process.env.VITE_URL || 'http://localhost:8080';
let backendOrigin = '';
try {
  const url = new URL(backendUrl);
  backendOrigin = url.origin;
} catch (e) {
  console.warn('Invalid VITE_URL:', backendUrl);
}

export default defineConfig({
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },
  plugins: [
    react(),
    {
      name: 'html-transform',
      transformIndexHtml(html) {
        // Replace placeholder preconnect URLs with actual backend URL
        html = html.replace(/https:\/\/api\.example\.com/g, backendOrigin);

        // Ensure fetchpriority is added to the main script
        html = html.replace(
          /<script type="module" crossorigin src="(\/assets\/index-[^"]+\.js)"><\/script>/,
          '<script type="module" crossorigin src="$1" fetchpriority="high"></script>'
        );

        return html;
      }
    },
    {
      name: 'copy-files',
      closeBundle() {
        // Copy preview.png to dist folder after build
        try {
          copyFileSync(
            resolve(__dirname, 'preview.png'),
            resolve(__dirname, 'dist', 'preview.png')
          );
          console.log('✓ Copied preview.png to dist');
        } catch (err) {
          console.warn('Warning: Could not copy preview.png:', err.message);
        }
      }
    }
  ],
  // Note: VITE_IDENTITY and VITE_URL are automatically loaded from .env files
  // Don't use define here as it runs before .env is loaded
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: backendUrl,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        ws: true
      }
    }
  },
  optimizeDeps: {
    exclude: ['./wasm/pkg/nullspace_wasm.js']
  },
  build: {
    modulePreload: {
      polyfill: true
    }
  }
})
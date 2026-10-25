import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Matches PANEL_PATH in ../shared/protocol.ts and the proxy's /ai/panel* route. */
const BASE = '/ai/panel/'

/** Inside the Docker network. Only the proxy reaches it. */
const DEV_PORT = 5173

/**
 * The browser never talks to the dev server directly, it goes through Caddy,
 * so the hot-reload socket has to be told the published port. Keep in sync
 * with the proxy's port in dev/containers/docker-compose.ai.yml.
 */
const PROXY_PORT = 3080

/** The schemas the service and this app share live outside the Vite root. */
const sharedIndex = new URL('../shared/index.ts', import.meta.url).pathname

export default defineConfig({
  base: BASE,
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@shared$/, replacement: sharedIndex }]
  },
  server: {
    host: true,
    port: DEV_PORT,
    strictPort: true,
    fs: { allow: ['..'] },
    hmr: { clientPort: PROXY_PORT }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true
  }
})

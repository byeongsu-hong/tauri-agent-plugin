import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  server: {
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
    host: '127.0.0.1',
    port: 1420,
    strictPort: true
  },
  clearScreen: false
})

import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['guest-js/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist-js',
    external: ['@tauri-apps/api']
  },
  {
    entry: { 'tauri-agent': 'bin/tauri-agent.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    outDir: 'dist-cli'
  }
])

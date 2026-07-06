import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'guest-js/index.ts',
      daemon: 'daemon/index.ts',
      mcp: 'mcp/index.ts',
      protocol: 'protocol/index.ts'
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist-js',
    external: ['@tauri-apps/api']
  },
  {
    entry: { 'tauri-agent': 'bin/tauri-agent.ts', 'tauri-agent-mcp': 'bin/tauri-agent-mcp.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    outDir: 'dist-cli'
  }
])
